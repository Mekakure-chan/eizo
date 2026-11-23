import './tab-status.js';
import { mp4StatusText } from './mp4-merge-error.mjs';
import { httpUrl, timeLabel } from './media.mjs';
import { acquireRun } from './acquire-run.mjs';
import { openSourceChoices } from './jobs.mjs';
import { createFolderControls } from './manager-folders.mjs';
import { createQueueList, queueGroup } from './manager-list.mjs';
import { allEntries, detachedState, gapPreferenceKey, listWorkerKey, managerSender, needsSourceTab, omissionText, pagePrefix, phaseLabel, readEntry, readGapPreference, recoverListWork, sendQueue, sourceTabHint, statusPrefix, writeState } from './queue.mjs';
import { exportMedia, exportName, finishMergeFailure, sizeLabel } from './queue-transfer.mjs';
import { cleanQueueFiles, dropFiles, runLock } from './queue-files.mjs';
import { recordFormats } from './recording.mjs';
import { acquireSaveSlot, commitStatus, saveProgress, saveWaitText, storageSaveText } from './save-folder.mjs';

const $ = id => document.getElementById(id);
const id = new URLSearchParams(location.search).get('q');
const tab = await chrome.tabs.getCurrent();
const gapKey = gapPreferenceKey(tab.incognito);
const gapSetting = $('allow-gaps');
gapSetting.onchange = async () => {
  gapSetting.disabled = true;
  try { await chrome.storage.local.set({[gapKey]:gapSetting.checked}); }
  catch (error) { gapSetting.checked = !gapSetting.checked; notice(error); }
  finally { gapSetting.disabled = false; }
};
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id === chrome.runtime.id && msg?.op === 'locate-manager' && msg.url === location.href && msg.incognito === tab.incognito)
    reply({ tabId: tab.id });
});
const typeNames = { hls: 'HLS', file: '動画ファイル', whole: '全編ダウンロード', record: 'キャプチャ' };
let current, state, operation, finish, ownerRun, tabIndicator;
let preferredFolder, closingRun;
const entries = new Map(), listRuns = new Map();
const queueList = createQueueList($('list'), {link,meter,act:listAction});
const filters = new Map([...$('list-filters').children].map(button => [button.dataset.filter,button]));
const emptyQueueText = $('empty').textContent;
if (id) $('list-title').textContent = 'ほかのページのキュー';
let selectedFilter = sessionStorage.getItem('queue-list-filter');
if (!filters.has(selectedFilter)) selectedFilter = 'all';
for (const [key,button] of filters) {
  button.onclick = () => {
    if (key === selectedFilter) return;
    selectedFilter = key;
    sessionStorage.setItem('queue-list-filter',key);
    renderList();
  };
}

function notice(error) {
  $('notice').textContent = error?.message || String(error);
  $('notice').hidden = false;
}
function saveLabel() {
  return !preferredFolder ? '保存' : state?.phase === 'ready' && state.folderPermission ? '保存先を再許可して保存' : '保存して閉じる';
}
async function saveWaiting() {
  const reply = await chrome.runtime.sendMessage({op:'save-ready-to-folder'});
  if (reply?.error) throw new Error(reply.error);
}
const {refresh:refreshFolder, authorize:authorizeFolder} = createFolderControls(tab.incognito ? 'private' : 'normal', {
  saveWaiting, notice,
  onRefresh(folder) {
    preferredFolder = folder;
    $('save').textContent = saveLabel();
    $('raw').textContent = folder ? '元のTSを保存して閉じる' : '元のTSを保存';
    if (entries.size) renderList();
  }
});

function link(a, page) {
  const url = httpUrl(page.sourceUrl);
  if (!url) { a.hidden = true; return; }
  a.href = url.href;
  a.title = url.href;
  a.textContent = (page.manual ? '指定したURL' : '元ページ') + ' · ' + url.host + url.pathname + (page.manual ? '' : url.search + url.hash);
}
function meter(bar, value) {
  if (Number.isFinite(value)) bar.value = Math.min(1, Math.max(0, value));
  else bar.removeAttribute('value');
}
function showActions(...ids) {
  for (const el of document.querySelector('.actions').children) el.hidden = !ids.includes(el.id);
}
function engineAction(action, raw = false) {
  return chrome.runtime.sendMessage({op:'engine-action',id,run:current.run,action,raw}).then(reply => {
    if (reply?.error) throw new Error(reply.error);
  });
}

function renderCurrent() {
  const phase = state.phase, output = state.output, job = current.job;
  const folderBlocked = phase === 'ready' && state.folderPermission && preferredFolder;
  $('save').textContent = saveLabel();
  $('current').hidden = false;
  $('all').hidden = false;
  $('heading').textContent = 'ダウンロードキュー';
  $('title').textContent = current.title;
  $('kind').textContent = typeNames[job.kind] + (job.label && job.label !== current.title ? ' · ' + job.label : '');
  link($('original'), current);
  $('phase').dataset.state = phase;
  $('phase').dataset.group = queueGroup(state);
  const recordHint = $('format').length ? '録画形式を選んで「録画を開始」を押してください。' : 'このブラウザーで利用できる録画形式がありません。';
  $('status').textContent = mp4StatusText(state) || (phase === 'setup' ? recordHint : '開始を待っています…');
  $('status').classList.toggle('error', ['failed', 'interrupted', 'mergeFailed'].includes(phase));
  $('info').textContent = [output?.bytes ? sizeLabel(output.bytes) : '', output?.duration ? timeLabel(output.duration) : '',
    state.info, omissionText(state), state.destinationName && ['saveQueued','saving','saved'].includes(phase) ? '保存先 · ' + state.destinationName : '',
    sourceTabHint(current,state)].filter(Boolean).join(' · ');
  const moving = ['fetching', 'recording', 'saving'].includes(phase) && state.saveStage !== 'choosing';
  $('progress').hidden = !moving;
  meter($('progress'), state.progress);
  const percent = moving && Number.isFinite(state.progress) ? Math.round(state.progress * 100) + '%' : '';
  $('percent').textContent = percent;
  const amount = percent || (moving && state.progressDetail);
  tabIndicator ??= globalThis.embeddedVideoTabIndicator();
  tabIndicator.show({...state, folderPermission:folderBlocked, partial:!!output?.interruption}, override => {
    const caption = folderBlocked ? '保存先の許可待ち' : override || phaseLabel(state);
    $('phase').textContent = caption;
    const title = (amount ? amount + ' ' : '') + caption + ' · ' + current.title;
    if (document.title !== title) document.title = title;
  });
  const recovery = state.sourceProblem && Number.isInteger(job.tabId) ? ['rescan','capture'] : [];
  if (current.owner !== tab.id) { showActions('owner'); return; }
  if (phase === 'ready') showActions('save', ...(output?.raw ? ['raw'] : []), 'discard');
  else if (phase === 'reader' || phase === 'method') showActions('retry', 'cancel');
  else if (phase === 'permission') showActions('grant', 'cancel');
  else if (phase === 'setup') showActions('format-label', 'record', 'show', 'cancel');
  else if (phase === 'fetching' || phase === 'recording') {
    $('stop').textContent = phase === 'recording' ? '録画を停止' : '取得を停止';
    showActions(...(phase === 'recording' ? ['stop','show'] : state.live ? ['stop'] : []), 'cancel');
  } else if (['updateRetry','saveQueued'].includes(phase) || (phase === 'saving' && state.saveStage !== 'committing')) showActions('cancel');
  else if (phase === 'saved') showActions(...recovery);
  else if (['failed','interrupted','canceled'].includes(phase)) {
    const choices = state.readerDisconnected || !recovery.length ? ['retry', ...recovery] : recovery;
    if (phase === 'failed' && state.canSkip) choices.push('skip-gaps');
    showActions(...choices);
  }
  else showActions();
}

const finished = state => ['saved','canceled','mergeFailed'].includes(state.phase);

function renderList() {
  const scoped = [...entries.values()].filter(e => e.page?.incognito === tab.incognito && e.state);
  const others = scoped.filter(e => e.page.id !== id);
  $('collection').hidden = !!id && !others.length;
  const counts = {all:others.length,active:0,queued:0,attention:0,stopped:0,saved:0};
  const visible = others.filter(({state}) => {
    const group = queueGroup(state);
    counts[group]++;
    return selectedFilter === 'all' || selectedFilter === group;
  });
  const countText = !others.length ? '' : selectedFilter === 'all' ? others.length + '件' : visible.length + '件 / 全' + others.length + '件';
  if ($('list-count').textContent !== countText) $('list-count').textContent = countText;
  visible.sort((a,b) => {
    if (selectedFilter === 'all' && finished(a.state) !== finished(b.state)) return finished(a.state) ? 1 : -1;
    return b.page.started - a.page.started;
  });
  const bar = $('list-filters'), focus = document.activeElement;
  const hadFocus = bar.contains(focus) || $('list').contains(focus);
  const multipleGroups = [...filters.keys()].filter(key => key !== 'all' && counts[key] > 0).length > 1;
  bar.hidden = !others.length || (selectedFilter === 'all' && !multipleGroups);
  for (const [key,button] of filters) {
    const count = String(counts[key]), badge = button.lastElementChild;
    if (badge.textContent !== count) badge.textContent = count;
    const hidden = key !== 'all' && key !== selectedFilter && !counts[key];
    if (button.hidden !== hidden) button.hidden = hidden;
    const pressed = String(key === selectedFilter);
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed',pressed);
  }
  const selected = filters.get(selectedFilter);
  $('empty').hidden = !!visible.length;
  if (!visible.length) $('empty').textContent = others.length
    ? '「' + selected.firstChild.textContent.trim() + '」の動画はありません。' : emptyQueueText;
  queueList.render(scoped,visible,preferredFolder);
  if (hadFocus && (document.activeElement === document.body || focus.closest('[hidden]'))) {
    const target = focus.isConnected && !focus.closest('[hidden]') && !focus.disabled ? focus :
      !bar.hidden ? selected : $('list').querySelector('.row-detail') || $('heading');
    target.focus({preventScroll:true});
  }
}

async function refresh(currentChanged = true, changedRows = null) {
  if (changedRows) { for (const entry of changedRows) queueList.update(entry); }
  else renderList();
  if (!id || !currentChanged) return;
  const selected = entries.get(id);
  if (!selected?.state || selected.page?.incognito !== tab.incognito) {
    tabIndicator?.close(); tabIndicator = null;
    document.title = 'セッション終了 · ダウンロードキュー';
    $('current').hidden = true; $('all').hidden = false;
    notice(new Error('このキューのセッションが終了しました。元の動画ページから開き直してください。')); return;
  }
  current = selected.page; state = selected.state;
  renderCurrent();
  if (current.owner !== tab.id) return;
  if (state.phase === 'saved' && state.closeViewer === tab.id && closingRun !== current.run) {
    closingRun = current.run;
    await sendQueue('queue-close-saved', {id, run:current.run});
    return;
  }
  if (current.runner === 'engine' || state.backgroundSave || state.workerTab != null) return;
  if (ownerRun === current.run) return;
  ownerRun = current.run;
  $('notice').hidden = true;
  const nativeGranted = state.phase === 'permission' && current.job.kind === 'whole' &&
    state.permission?.permissions?.includes('nativeMessaging') && await chrome.permissions.contains(state.permission);
  if (state.phase === 'queued' || nativeGranted) { void acquire().catch(notice); return; }
  const interrupted = detachedState(state);
  if (interrupted) await navigator.locks.request(runLock(current.run), { ifAvailable: true }, lock =>
      lock && writeState(id, selected.page.run, interrupted));
}

async function acquire() {
  if (operation || !current || current.owner !== tab.id) return;
  if (current.runner === 'engine') return engineAction('retry');
  await acquireInTab(current,state,$('format').value);
}

async function acquireInTab(page, previous, format, skipGaps = false) {
  const inList = page.id !== id || page.owner !== tab.id;
  if (listRuns.has(page.run) || (!inList && operation)) return;
  const controller = new AbortController(), stop = new AbortController();
  if (inList) listRuns.set(page.run,{controller,stop});
  else { operation = controller; finish = stop; }
  try {
    if (inList) await chrome.storage.session.set({[listWorkerKey(tab.id)]:true});
    await acquireRun(page,controller,stop,(next, expected) => {
      const running = next.phase === 'fetching' || next.phase === 'recording';
      return writeState(page.id,page.run,inList && running ? {...next,workerTab:tab.id} : next,expected);
    },{expectedPhase:previous.phase, recordFormat:format, skipGaps:skipGaps || previous.resumeWithGaps, previousFailure:previous.skipSegment},notice);
  } finally {
    if (inList) listRuns.delete(page.run);
    else { operation = finish = null; }
  }
}

async function localCommand(action, {page,state:s}, format) {
  const work = listRuns.get(page.run) || (current?.run === page.run && current.owner === tab.id && operation
    ? {controller:operation,stop:finish} : null);
  if (action === 'cancel' || action === 'stop') {
    if (s.phase === 'saving' && s.saveStage === 'committing') return false;
    if (work) { (action === 'stop' ? work.stop : work.controller)?.abort(); return true; }
    if (action === 'cancel' && ['permission','setup','reader','method'].includes(s.phase)) {
      return writeState(page.id,page.run,{phase:'canceled',text:'取得を中止しました。',progress:null},s.phase);
    }
    return false;
  }
  if (work || !['retry','record','grant','skip-gaps'].includes(action)) return false;
  if (action === 'skip-gaps' && (s.phase !== 'failed' || !s.canSkip || page.job.kind !== 'hls')) return false;
  if (action === 'record' && (s.phase !== 'setup' || page.job.kind !== 'record' || !recordFormats().includes(format))) return false;
  if (action === 'grant' && (s.phase !== 'permission' || !s.permission || !await chrome.permissions.contains(s.permission))) return false;
  if (action === 'retry' && !['failed','interrupted','canceled','reader','method'].includes(s.phase)) return false;
  if (action === 'retry' && page.job.kind === 'record') return writeState(page.id,page.run,{phase:'setup',text:'',progress:null},s.phase);
  if (action === 'grant' && s.permission.permissions?.includes('nativeMessaging') && !chrome.runtime.sendNativeMessage) {
    if (page.id !== id) sessionStorage.setItem('resume-list-grant',JSON.stringify({id:page.id,run:page.run}));
    setTimeout(() => location.reload(),0);
    return true;
  }
  void acquireInTab(page,s,format,action === 'skip-gaps').catch(notice);
  return true;
}

chrome.runtime.onMessage.addListener((msg,sender,reply) => {
  if (msg?.op !== 'manager-control' || msg.target !== tab.id || sender.id !== chrome.runtime.id || !managerSender(sender)) return;
  (async () => {
    const entry = await readEntry(msg.id), {page,state:s} = entry;
    if (!page || page.incognito !== tab.incognito || page.run !== msg.run || s.phase !== msg.phase ||
        !(page.id === id && page.owner === tab.id || listRuns.has(page.run))) return false;
    return localCommand(msg.action,entry,msg.format);
  })().then(ok => reply({ok}),error => reply({error:error.message}));
  return true;
});

async function tabCommand(action, entry, format) {
  const {page,state:s} = entry, target = s.workerTab ?? page.owner;
  if (Number.isInteger(target) && target !== tab.id) {
    const msg = {op:'manager-control',target,id:page.id,run:page.run,phase:s.phase,action,format};
    const reply = await chrome.runtime.sendMessage(msg).catch(() => null);
    if (reply?.error) throw new Error(reply.error);
    if (reply?.ok) return true;
  }
  const fresh = await readEntry(page.id);
  if (fresh.page?.run !== page.run || fresh.state?.phase !== s.phase) return false;
  return localCommand(action,fresh,format);
}

async function listAction(action, entry, format) {
  const {page,state:s} = entry, key = {id:page.id,run:page.run};
  if (action === 'details') return sendQueue('queue-open',key);
  if (action === 'rescan') return openSourceChoices(page.job,'recover');
  if (action === 'close-source') {
    if (!await sendQueue('queue-close-source',key)) throw new Error('元タブが別のページに変わったか、取得に使用中です。');
    return;
  }
  if (action === 'discard' && !confirm('「' + page.title + '」の取得済み動画を破棄しますか？')) return;
  if (action === 'grant' && (!s.permission || !await chrome.permissions.request(s.permission))) throw new Error('取得に必要な許可がありません。');
  const exportAction = ['save','raw','discard'].includes(action);
  const raw = action === 'raw';
  if (action === 'save' || raw) {
    action = 'save';
    if (preferredFolder) { await authorizeFolder(); action = 'save-folder'; }
  }
  let ok;
  if (exportAction || page.runner === 'engine' || s.backgroundSave) {
    const reply = await chrome.runtime.sendMessage({op:'list-action',...key,phase:s.phase,action:action === 'grant' ? 'retry' : action,raw});
    if (reply?.error) throw new Error(reply.error);
    ok = reply?.value;
  } else ok = await tabCommand(action,entry,format);
  if (!ok) throw new Error('状態が変わりました。一覧の現在の操作を確認してください。');
}

async function save(raw) {
  if (operation || state?.phase !== 'ready' || current.owner !== tab.id) return;
  if (preferredFolder) {
    const reauthorizing = state.folderPermission;
    await authorizeFolder();
    return reauthorizing && !raw ? saveWaiting() : engineAction('save-folder',raw);
  }
  if (current.runner === 'engine') return engineAction('save', raw);
  const page = current, ready = state;
  const ext = raw ? 'ts' : ready.output.extension;
  const filename = exportName(page,ready.output,ext);
  const controller = new AbortController();
  operation = controller;
  let writer, releaseSlot;
  try {
    const picking = showSaveFilePicker({ suggestedName: filename });
    picking.catch(() => {});
    if (!await writeState(id, page.run, { ...ready, phase:'saveQueued', saveStage:'choosing', text:'保存先を選んでいます…', progress:null }, 'ready')) return;
    const destination = await picking;
    await navigator.locks.request(runLock(page.run), async () => {
      if (!await writeState(id, page.run, {...ready,phase:'saveQueued',saveStage:null,text:saveWaitText,progress:null},'saveQueued')) return;
      releaseSlot = await acquireSaveSlot(controller.signal);
      controller.signal.throwIfAborted();
      writer = await destination.createWritable();
      const saving = {...ready,phase:'saving',saveStage:null,progressDetail:null,text:storageSaveText};
      await writeState(id, page.run, {...saving,progress:0});
      const duration = await exportMedia(page.run, ext, writer, controller.signal, saveProgress(progress => {
        void writeState(id,page.run,{...saving,progress},'saving').catch(notice);
      }));
      if (ready.output.omittedRanges && Number.isFinite(duration)) saving.output = {...ready.output, duration};
      controller.signal.throwIfAborted();
      if (!await writeState(id,page.run,{...saving,...commitStatus},'saving')) throw new DOMException('保存が中断しました。','AbortError');
      controller.signal.throwIfAborted();
      await writer.close();
      writer = null;
      await writeState(id, page.run, { ...ready, output:saving.output, phase: 'saved', text: destination.name + ' を保存しました。', progress: null });
      await dropFiles(page.run).catch(() => {});
    });
  } catch (error) {
    if (writer) await writer.abort().catch(() => {});
    if (await finishMergeFailure(page.run,error,ready.output.omittedRanges,next => writeState(id,page.run,next,'saving'))) return;
    if (error.missingSpool) {
      await writeState(id, page.run, { phase: 'interrupted', text: error.message, progress: null });
      return;
    }
    const text = error.name === 'AbortError' ? '保存をキャンセルしました。取得済みの動画は保存待ちです。' : '保存できませんでした。' + error.message;
    await writeState(id, page.run, { ...ready, text });
  } finally { releaseSlot?.(); operation = null; }
}

$('all').onclick = () => sendQueue('queue-index').catch(notice);
$('owner').onclick = () => sendQueue('queue-open', { id }).catch(notice);
$('save').onclick = () => save(false).catch(notice);
$('raw').onclick = () => save(true).catch(notice);
$('record').onclick = () => acquire().catch(notice);
$('skip-gaps').onclick = () => listAction('skip-gaps',{page:current,state}).catch(notice);
$('retry').onclick = () => {
  if (current.job.kind === 'record') {
    void writeState(id, current.run, { phase: 'setup', text: '', progress: null }).catch(notice);
  } else {
    void acquire().catch(notice);
  }
};
$('grant').onclick = async () => {
  const { permission } = state;
  try {
    if (!permission || !await chrome.permissions.request(permission)) {
      notice(new Error('読み取りは許可されませんでした。許可すると取得を開始できます。')); return;
    }
    // A page opened before the first nativeMessaging grant may lack its runtime methods.
    if (permission.permissions?.includes('nativeMessaging')) location.reload();
    else await acquire();
  } catch (error) { notice(error); }
};
$('cancel').onclick = () => {
  if (state.phase === 'saving' && state.saveStage === 'committing') return;
  if (current.runner === 'engine' || state.backgroundSave) { void engineAction('cancel').catch(notice); return; }
  if (state.workerTab != null) { void tabCommand('cancel',{page:current,state}).catch(notice); return; }
  if (operation) operation.abort();
  else if (['permission','setup','reader','method'].includes(state.phase)) void writeState(id, current.run, { phase: 'canceled', text: '取得を中止しました。', progress: null }).catch(notice);
};
$('stop').onclick = () => current.runner === 'engine' ? engineAction('stop').catch(notice) : tabCommand('stop',{page:current,state}).catch(notice);
$('show').onclick = () => chrome.tabs.update(current.job.tabId, { active: true }).then(t => chrome.windows.update(t.windowId, { focused: true })).catch(notice);
$('rescan').onclick = () => openSourceChoices(current.job, 'recover').catch(notice);
$('capture').onclick = () => openSourceChoices(current.job, 'capture').catch(notice);
$('discard').onclick = async () => {
  if (operation || state.phase !== 'ready' || !confirm('取得済みの動画を破棄しますか？')) return;
  if (current.runner === 'engine') { await engineAction('discard').catch(notice); return; }
  const run = current.run;
  try {
    await navigator.locks.request(runLock(run), async () => {
      if (!(await writeState(id, run, { phase: 'canceled', text: '取得済みの動画を破棄しました。', progress: null }, 'ready'))) return;
      await dropFiles(run);
    });
  } catch (error) { notice(error); }
};

for (const format of recordFormats()) $('format').add(new Option(format.toUpperCase(), format));
$('record').disabled = !$('format').length;
let loading = true;
const initialChanges = [];
const checkingRuns = new Map();
async function checkBackgroundRun(page, check) {
  checkingRuns.set(page.run, check);
  try {
    do {
      check.again = false;
      await sendQueue('queue-recover', {id:page.id, run:page.run});
    } while (check.again);
  } finally { checkingRuns.delete(page.run); }
}
function recoverListEntries(nativeDownloadEnded = false) {
  if (loading) return;
  for (const {page, state} of entries.values()) {
    if (!page || page.incognito !== tab.incognito || !(page.runner === 'engine' || state?.backgroundSave) ||
        !['queued','fetching','saveQueued','saving'].includes(state?.phase) || (nativeDownloadEnded && state.phase !== 'saving')) continue;
    const pending = checkingRuns.get(page.run);
    if (pending) {
      if (nativeDownloadEnded) pending.again = true;
    } else void checkBackgroundRun(page, {}).catch(notice);
  }
}
window.addEventListener('focus', () => recoverListEntries());
chrome.downloads.onChanged.addListener(delta => {
  if (['complete','interrupted'].includes(delta.state?.current)) recoverListEntries(true);
});
function applyChanges(changes) {
  const changedRows = new Set();
  let layoutChanged = false, currentChanged = false;
  for (const [key, change] of Object.entries(changes)) {
    const prefix = key.startsWith(pagePrefix) ? pagePrefix : key.startsWith(statusPrefix) ? statusPrefix : null;
    if (!prefix) continue;
    const changedId = key.slice(prefix.length), entry = entries.get(changedId) || {};
    const previous = entry.state, next = change.newValue;
    if (prefix === pagePrefix || !entry.page || !previous || !next || queueGroup(previous) !== queueGroup(next) ||
        finished(previous) !== finished(next) ||
        needsSourceTab(entry.page,previous) !== needsSourceTab(entry.page,next)) layoutChanged = true;
    entry[prefix === pagePrefix ? 'page' : 'state'] = change.newValue;
    entries.set(changedId, entry);
    changedRows.add(entry);
    if (changedId === id) currentChanged = true;
  }
  if (changedRows.size && !loading) void refresh(currentChanged,layoutChanged ? null : changedRows).catch(notice);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[gapKey]) gapSetting.checked = changes[gapKey].newValue !== false;
  if (area !== 'session') return;
  if (loading) initialChanges.push(changes); else applyChanges(changes);
});
addEventListener('beforeunload', event => {
  if (operation || listRuns.size) { event.preventDefault(); event.returnValue = ''; }
});
addEventListener('pagehide', () => {
  operation?.abort();
  for (const job of listRuns.values()) job.controller.abort();
});
try { gapSetting.checked = await readGapPreference(tab.incognito); gapSetting.disabled = false; }
catch (error) { notice(error); }
await recoverListWork(tab.id).catch(notice);
void cleanQueueFiles().catch(() => {});
await refreshFolder().catch(notice);
for (const entry of await allEntries(tab.incognito)) entries.set(entry.page.id, entry);
for (const changes of initialChanges) applyChanges(changes);
initialChanges.length = 0;
loading = false;
if (id && entries.get(id)?.page && entries.get(id).page.owner !== tab.id) await sendQueue('queue-claim', { id }).catch(notice);
await refresh().catch(notice);
recoverListEntries();
const pendingGrant = sessionStorage.getItem('resume-list-grant');
if (pendingGrant) {
  sessionStorage.removeItem('resume-list-grant');
  const key = JSON.parse(pendingGrant), entry = entries.get(key.id);
  if (entry?.page?.run === key.run && entry.state.phase === 'permission' &&
      await chrome.permissions.contains(entry.state.permission)) void acquireInTab(entry.page,entry.state).catch(notice);
}
