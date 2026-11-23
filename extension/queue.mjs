import { httpUrl, timeLabel } from './media.mjs';
import { blocksUpdateRetry, isAcquisitionUpdateFailure } from './update-retry.mjs';

export const pagePrefix = 'download-page:';
export const statusPrefix = 'download-state:';
// Prior versions stored an opt-in. Start both scopes in automatic mode on upgrade.
export const gapPreferenceKey = incognito => 'hls-auto-skip-gaps:' + (incognito ? 'private' : 'normal');
export async function readGapPreference(incognito) {
  const key = gapPreferenceKey(incognito);
  return (await chrome.storage.local.get(key))[key] !== false;
}

export function omissionText(state, limit) {
  const ranges = state.omittedRanges ?? state.output?.omittedRanges;
  if (!ranges?.length) return '';
  const shown = limit ? ranges.slice(0,limit) : ranges;
  const source = state.output?.sourceDuration ?? state.sourceDuration;
  const duration = state.output?.duration ?? state.duration;
  const times = source > 0 && duration > 0 ? '元の長さ ' + timeLabel(source) + '、' +
    (state.phase === 'saved' ? '保存した長さ ' : '保存予定の長さ ') + timeLabel(duration) + '。' : '';
  return times + shown.join('、') + (shown.length < ranges.length ? ' ほか' + (ranges.length - shown.length) + '件' : '');
}

export const phaseNames = {
  queued: '開始待ち', updateRetry:'自動再取得待ち', fetching: '取得中', reader: '取得方法を選択', method: '選択待ち', permission: '許可待ち', setup: '録画待ち',
  recording: '録画中', ready: '保存待ち', saveQueued: '書き出し待ち', saving: '保存中', saved: '保存済み',
  failed: 'エラー', mergeFailed: '結合に失敗しました', interrupted: '中断', canceled: 'キャンセル'
};
export function phaseLabel(state) {
  if (['ready','saved'].includes(state.phase) && (state.omittedRanges ?? state.output?.omittedRanges)?.length) {
    return phaseNames[state.phase] + '（欠損あり）';
  }
  if (state.phase === 'saving' && state.saveStage === 'committing') return '保存を確定中';
  if (state.phase === 'saving' && state.saveStage === 'preparing') return '保存準備中';
  if (['saving','saveQueued'].includes(state.phase) && state.saveStage === 'choosing') return '保存先を選択中';
  return phaseNames[state.phase] || state.phase;
}
export const keepsPlace = phase => ['queued', 'updateRetry', 'fetching', 'method', 'permission', 'setup', 'recording', 'ready', 'saveQueued', 'saving'].includes(phase);
const lock = (id, work) => navigator.locks.request('embedded-video-queue/' + id, work);
const urlFor = id => chrome.runtime.getURL('manager.html') + (id ? '?q=' + id : '');
const opening = new Map();

function registerOwner(page, tabId) {
  const key = 'download-owner:' + tabId;
  return lock(key, () => chrome.storage.session.set({
    [pagePrefix + page.id]:{...page,owner:tabId}, [key]:page.id
  }));
}

export function managerSender(sender) {
  return !!sender.tab && sender.frameId === 0 && sender.url?.split('?')[0] === urlFor() &&
    sender.tab.incognito === !!chrome.extension.inIncognitoContext;
}

export function needsSourceTab(page, state) {
  if (!state || ['ready','saveQueued','saving','saved','failed','mergeFailed','interrupted','canceled'].includes(state.phase)) return false;
  if (page.job.kind === 'record') return true;
  return page.job.kind === 'hls' && !(state.phase === 'fetching' && ['queue','detached'].includes(state.readerMode));
}

export function sourceTabHint(page, state, tab = '元の動画タブ') {
  if (state.phase !== 'fetching') return '';
  if (page.job.kind === 'file') return tab + 'は閉じられます。';
  if (page.job.kind !== 'hls') return '';
  if (state.readerMode === 'original') return '保存待ちまで' + tab + 'を開いたままにしてください。';
  if (!needsSourceTab(page,state)) return tab + 'は閉じられます。';
  return '取得方法を確認しています。' + tab + 'はそのままでお待ちください。';
}

export const sourceDocument = page => page.sourceDocument || page.job.sourceDoc;

async function closeSource(page, state, sender) {
  const tabId = page.job.tabId, doc = sourceDocument(page);
  if (!doc || page.manual || !Number.isInteger(tabId) || tabId === sender.tab.id || needsSourceTab(page,state)) return false;
  const jobs = await allEntries(page.incognito);
  if (jobs.some(entry => entry.page.job.tabId === tabId && (!sourceDocument(entry.page) || sourceDocument(entry.page) === doc) &&
    needsSourceTab(entry.page,entry.state))) return false;
  const [tab,frame] = await Promise.all([chrome.tabs.get(tabId).catch(() => null),
    chrome.webNavigation.getFrame({tabId,frameId:0}).catch(() => null)]);
  if (!tab || tab.incognito !== page.incognito || tab.status === 'loading' || tab.pendingUrl ||
      !frame || frame.errorOccurred || frame.documentId !== doc || frame.url !== page.sourceUrl ||
      (tab.url && tab.url !== page.sourceUrl)) return false;
  await chrome.tabs.remove(tabId);
  return true;
}

export async function pageId(sourceUrl, incognito = false, manual = false) {
  const source = httpUrl(sourceUrl);
  if (!source) throw new Error('元ページのURLを確認できませんでした。');
  const data = new TextEncoder().encode(JSON.stringify([incognito, manual, source.href]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
}

export async function readEntry(id) {
  const a = pagePrefix + id, b = statusPrefix + id;
  const values = await chrome.storage.session.get([a, b]);
  return { page: values[a], state: values[b] };
}

function changeState(id, run, choose) {
  return lock(id, async () => {
    const { page, state } = await readEntry(id);
    if (!page || page.run !== run) return false;
    let next = choose(page,state);
    if (!next) return false;
    const patch = {};
    // Commit the budget with the first acquisition write. If the worker stops before this
    // point the request is still waiting; after it, even a new worker sees a spent attempt.
    let retry = page.updateRetry;
    if (state?.run === run && state.phase === 'updateRetry') {
      // Dispatch and acquisition can be separated by startup or a queue lock. A job
      // that started meanwhile takes priority; leave this attempt available for later.
      if (next.phase === 'fetching') {
        const entries = await allEntries(page.incognito);
        if (entries.some(({page:owner,state:other}) => other && other.run === owner.run && blocksUpdateRetry(other.phase,other.folderSavePending))) return false;
      }
      if (next.phase === 'canceled') retry = 'canceled';
      else if (['fetching','failed','interrupted'].includes(next.phase)) retry = 'used';
    } else if (retry === 'canceled' && state?.phase === 'canceled' && next.phase === 'fetching') {
      retry = null; // The user explicitly restarted a run whose automatic attempt never started.
    }
    if (retry !== page.updateRetry) patch[pagePrefix+id] = {...page,updateRetry:retry};
    if (isAcquisitionUpdateFailure(page,next)) {
      if (retry === 'canceled') {
        next = {phase:'canceled',text:'自動再取得を中止しました。',progress:null};
      } else if (retry === 'used') {
        next = {...next, text:'拡張の更新後に自動再取得を1回試しましたが、動画処理を読み込めませんでした。'};
      } else {
        // A queue tab may still have the old module cached. The retry runs in a fresh engine.
        if (page.runner !== 'engine') patch[pagePrefix+id] = {...page,runner:'engine'};
        next = {phase:'updateRetry',progress:null,text:'拡張の更新に伴い、ほかの動画の取得・保存が終わったら自動で1回再取得します。',
          ...(next.resumeWithGaps ? {resumeWithGaps:true,skipSegment:next.skipSegment ?? null} : {})};
      }
    }
    const stored = {...next,run};
    // The background worker can stop after the download finishes and before it hands
    // the file to the folder writer. Only a newly completed acquisition gets this flag.
    if (stored.phase === 'ready' && stored.output && state?.run === run && ['fetching','recording'].includes(state.phase)) {
      stored.folderSavePending = true;
    } else delete stored.folderSavePending;
    await chrome.storage.session.set({...patch,[statusPrefix+id]:stored});
    return stored;
  });
}

export function writeRunState(id, run, next, expectedPhase) {
  return changeState(id,run,(_page,state) => {
    // Only a command that claims this waiting phase can start, cancel or exhaust it.
    if (state?.phase === 'updateRetry' && (expectedPhase !== 'updateRetry' || state.run !== run)) return false;
    return (!expectedPhase || state?.phase === expectedPhase) && next;
  });
}

export async function writeState(id, run, next, expectedPhase) {
  return !!await writeRunState(id,run,next,expectedPhase);
}

export function matchesFolderCheck(state, check) {
  // Older queue tabs publish the completion message without the pending flag.
  return state?.phase === 'ready' && (!check || (!!state.folderSavePending === !!check.folderSavePending && state.text === check.text));
}

export function finishFolderCheck(id, run, checked, text) {
  return changeState(id,run,(_page,state) => matchesFolderCheck(state,checked) &&
    (text ? {...state,text} : state));
}

// Older, already-open queue tabs can still write the original English error.
export function reconcileUpdateFailure(id, run, incognito) {
  return changeState(id,run,(page,state) => page.incognito === incognito && state?.run === run &&
    isAcquisitionUpdateFailure(page,state) && state);
}

export async function allEntries(incognito) {
  const data = await chrome.storage.session.get(null);
  return Object.entries(data).filter(([key, page]) => key.startsWith(pagePrefix) && page.incognito === incognito)
    .map(([, page]) => ({ page, state: data[statusPrefix + page.id] }))
    .sort((a, b) => b.page.started - a.page.started);
}

async function existingTab(url, incognito, owner) {
  const tab = Number.isInteger(owner) && await chrome.tabs.get(owner).catch(() => null);
  if (tab && tab.incognito === incognito && (tab.pendingUrl || tab.url)?.split('#')[0] === url) return tab;
  const key = incognito + url;
  const reservation = opening.get(key);
  if (tab?.id === reservation?.id && reservation && tab.status === 'loading' &&
      Date.now() - reservation.time < 10000 && (!tab.pendingUrl || tab.pendingUrl === url)) return tab;
  opening.delete(key);
  // Extension tabs need not expose their URL through tabs.get without the "tabs" permission.
  const contexts = chrome.runtime.getContexts && await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  const match = contexts?.find(context => context.tabId === owner && context.incognito === incognito)
    || contexts?.find(context => context.incognito === incognito);
  const known = match || await chrome.runtime.sendMessage({ op: 'locate-manager', url, incognito }).catch(() => null);
  return Number.isInteger(known?.tabId) ? chrome.tabs.get(known.tabId).catch(() => null) : null;
}

async function installSourcePanel(job) {
  const result = await chrome.scripting.executeScript({
    target: { tabId: job.tabId, documentIds: [job.sourceDoc] }, files: ['tab-status.js', 'source-panel.js']
  }).catch(() => []);
  return result.some(r => r.frameId === 0 && r.documentId === job.sourceDoc && r.result === job.sourceUrl);
}

async function showTab(url, incognito, windowId, owner) {
  let tab = await existingTab(url, incognito, owner);
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    tab = await chrome.tabs.create({ url, active:true, ...(Number.isInteger(windowId) ? { windowId } : {}) });
    opening.set(incognito + url, { id: tab.id, time: Date.now() });
  }
  return tab;
}

// Call while holding the queue lock so recovery cannot overwrite a new export.
async function recoverBackground(page, state, engine, notify) {
  if (!(page?.runner === 'engine' || state?.backgroundSave) || !engine?.recover) return;
  const next = await engine.recover(page, state);
  if (!next) return;
  await chrome.storage.session.set({[statusPrefix + page.id]: next});
  if (notify) engine.present(page, next);
  return next;
}

export function unownedTabAcquisition(page, state) {
  return page.runner === 'tab' && page.owner == null && state.workerTab == null && !state.backgroundSave &&
    ['queued','fetching','recording'].includes(state.phase);
}

export function recoverBackgroundRun(id, run, incognito, engine) {
  return lock(id, async () => {
    const {page, state} = await readEntry(id);
    if (!page || page.incognito !== incognito || page.run !== run || state?.run !== run) return false;
    // queue-add holds this same lock until its tab is registered, so a slow tab opening
    // cannot be mistaken for a queue which lost its owner.
    if (unownedTabAcquisition(page,state)) {
      await chrome.storage.session.set({[statusPrefix+id]:detachedState(state)});
      return true;
    }
    return !!await recoverBackground(page, state, engine, true);
  });
}

// One lock covers the recheck, registration and tab creation, including simultaneous popup clicks.
export async function handleQueueRequest(msg, sender, engine) {
  const sourceTab = Number.isInteger(msg.sourceTabId) ? await chrome.tabs.get(msg.sourceTabId).catch(() => null) : null;
  const incognito = !!(sourceTab ?? sender.tab)?.incognito || (!sourceTab && !sender.tab && !!msg.incognito);
  const windowId = (sourceTab ?? sender.tab)?.windowId ?? msg.windowId;
  if (msg.op === 'queue-index') return lock('index-' + incognito, async () => {
    const key = 'download-index:' + incognito;
    const owner = (await chrome.storage.session.get(key))[key];
    const tab = await showTab(urlFor(), incognito, windowId, owner);
    if (tab.id !== owner) await chrome.storage.session.set({ [key]: tab.id });
    return true;
  });
  const id = msg.id || await pageId(msg.sourceUrl, incognito, !!msg.manual);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('キューを特定できません。');
  if (msg.op === 'queue-recover') return managerSender(sender) && recoverBackgroundRun(id, msg.run, sender.tab.incognito, engine);
  return lock(id, async () => {
    let { page, state } = await readEntry(id);
    if (page && page.incognito !== incognito) return false;
    if (msg.op === 'queue-close-source') return !!page && page.run === msg.run && state?.run === msg.run &&
      managerSender(sender) && closeSource(page,state,sender);
    if (msg.op === 'queue-open' && !page) return false;
    if (['queue-open','queue-find','queue-add','queue-claim'].includes(msg.op)) {
      const recovered = await recoverBackground(page, state, engine, msg.op === 'queue-open');
      state = recovered || state;
      if (msg.op === 'queue-find' && state?.phase !== 'reader' && !keepsPlace(state?.phase)) {
        if (recovered) engine.present(page,state);
        return false;
      }
    }
    if (msg.op === 'queue-close-saved') {
      if (!sender.tab || sender.url !== urlFor(id) || page?.owner !== sender.tab.id ||
          page.run !== msg.run || state?.phase !== 'saved') return false;
      await chrome.tabs.remove(sender.tab.id);
      return true;
    }
    if (msg.op === 'queue-claim') {
      if (!page || !sender.tab || sender.url !== urlFor(id)) return false;
      const prior = await existingTab(urlFor(id), incognito, page.owner);
      if (prior && prior.id !== sender.tab.id) return false;
      if (page.owner !== sender.tab.id) await registerOwner(page,sender.tab.id);
      return true;
    }
    // A repeated click opens the existing queue, including a choice left by an older version.
    let newRun = false;
    if (msg.op === 'queue-add' && !keepsPlace(state?.phase)) {
      const job = msg.job;
      if (!['hls', 'file', 'whole', 'record'].includes(job?.kind)) throw new Error('この形式をキューに追加できません。');
      const source = httpUrl(msg.sourceUrl);
      if (!source) throw new Error('元ページが見つかりません。');
      const run = crypto.randomUUID();
      const inline = !!engine && ['hls','file'].includes(job.kind) && !msg.manual && !!job.sourceDoc &&
        Number.isInteger(job.tabId) && job.tabId === msg.sourceTabId;
      const sourcePanel = inline && sourceTab?.id === job.tabId && await installSourcePanel(job);
      let doc = job.sourceDoc;
      if (!doc && sourceTab && sourceTab.id === job.tabId && !msg.manual) {
        const frame = await chrome.webNavigation.getFrame({tabId:sourceTab.id,frameId:0}).catch(() => null);
        if (frame?.url === source.href && !frame.errorOccurred) doc = frame.documentId;
      }
      newRun = true;
      page = { id, run, job, sourcePanel, runner:inline ? 'engine' : 'tab', sourceUrl: source.href, title: msg.sourceTitle || source.host,
        sourceDocument:doc || null, manual: !!msg.manual, incognito, started: Date.now(), owner: page?.owner ?? null };
      state = { run, phase: job.kind === 'record' ? 'setup' : 'queued', text: '', progress: null };
      await chrome.storage.session.set({ [pagePrefix + id]: page, [statusPrefix + id]: state });
    }
    if (!page) return false;
    if (page.runner === 'engine' && (msg.op === 'queue-add' || msg.op === 'queue-find')) {
      if (newRun) {
        try { await engine.start(page); }
        catch (error) {
          state = {run:page.run,phase:'failed',text:error.message,progress:null};
          await chrome.storage.session.set({[statusPrefix + id]:state});
        }
      }
      await engine.present(page,state);
      return true;
    }
    const tab = await showTab(urlFor(id), incognito, windowId, page.owner);
    if (tab.id !== page.owner) await registerOwner(page,tab.id);
    return true;
  });
}

export async function managerClosed(tabId, retainedId) {
  const interrupted = await recoverListWork(tabId);
  const ownerKey = 'download-owner:' + tabId;
  const id = (await chrome.storage.session.get(ownerKey))[ownerKey];
  if (!id || id === retainedId) return interrupted;
  await lock(id, async () => {
    const current = await readEntry(id);
    if (current.page?.owner === tabId) {
      const patch = { [pagePrefix + id]: { ...current.page, owner: null } };
      const state = current.page.runner === 'engine' || current.state?.workerTab != null ? null : detachedState(current.state);
      if (state) patch[statusPrefix + id] = state;
      await chrome.storage.session.set(patch);
      if (state?.phase === 'interrupted') interrupted.push({id,run:state.run});
    }
    await lock(ownerKey, async () => {
      if ((await chrome.storage.session.get(ownerKey))[ownerKey] === id) await chrome.storage.session.remove(ownerKey);
    });
  });
  return interrupted;
}

export const listWorkerKey = tabId => 'download-list-worker:' + tabId;

export async function recoverListWork(tabId) {
  const interrupted = [];
  const key = listWorkerKey(tabId);
  if (!(await chrome.storage.session.get(key))[key]) return interrupted;
  const jobs = await allEntries(!!chrome.extension.inIncognitoContext);
  for (const {page,state} of jobs) {
    if (state?.workerTab !== tabId) continue;
    await lock(page.id, async () => {
      const fresh = await readEntry(page.id);
      if (fresh.page?.run !== page.run || fresh.state?.workerTab !== tabId) return;
      const next = detachedState(fresh.state);
      if (next) await chrome.storage.session.set({[statusPrefix + page.id]:next});
      if (next?.phase === 'interrupted') interrupted.push({id:page.id,run:page.run});
    });
  }
  await chrome.storage.session.remove(key);
  return interrupted;
}

export function detachedState(state) {
  if (!state) return null;
  if (['saveQueued','saving'].includes(state.phase)) return state.backgroundSave ? null :
    { ...state, phase: 'ready', saveStage:null, progress: null, text: '取得済みです。保存先を選び直せます。' };
  if (['queued', 'fetching', 'reader', 'method', 'recording'].includes(state.phase)) return { run: state.run, phase: 'interrupted',
    text: '取得に使用していた画面が閉じられました。「再取得」で最初から取得できます。', progress: null };
  return null;
}

export function recoverManagerState(id, run, tabId, phase) {
  return changeState(id,run,(page,state) => page.owner === tabId && page.runner !== 'engine' &&
    state?.run === run && state.phase === phase && state.workerTab == null && !state.backgroundSave && detachedState(state));
}

export async function sendQueue(op, options = {}) {
  const reply = await chrome.runtime.sendMessage({ ...options, op });
  if (reply?.error) throw new Error(reply.error);
  return !!reply?.ok;
}
