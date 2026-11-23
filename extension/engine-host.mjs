import './serve-read.js';
import { mp4StatusText } from './mp4-merge-error.mjs';
import { hostPattern, httpUrl } from './media.mjs';
import { openSourceChoices, requireOrigins } from './jobs.mjs';
import { dropFiles, runLock } from './queue-files.mjs';
import { getSaveFolder, registerSaveFolder, removeSaveFolder, selectSaveFolder } from './save-folder.mjs';
import { originalTarget } from './queue-player.mjs';
import { hlsFetchFor } from './page-request.mjs';
import { allEntries, finishFolderCheck, handleQueueRequest, managerSender, matchesFolderCheck, omissionText, phaseLabel, readEntry, readGapPreference,
  reconcileUpdateFailure, recoverBackgroundRun, sourceTabHint, statusPrefix, unownedTabAcquisition, writeRunState, writeState } from './queue.mjs';
import { blocksUpdateRetry, isAcquisitionUpdateFailure, isUpdateModuleError } from './update-retry.mjs';

const engineUrl = chrome.runtime.getURL('engine.html');
const extensionOrigin = new URL(engineUrl).origin;
const frameStatus = new Map(), readers = new Map();
const panelUpdates = new Map();
const lifecycle = work => navigator.locks.request('embedded-video-offscreen-lifecycle', work);
async function activeDocument() {
  if (chrome.runtime.getContexts) return (await chrome.runtime.getContexts({
    contextTypes:['OFFSCREEN_DOCUMENT'], documentUrls:[engineUrl], incognito:chrome.extension.inIncognitoContext
  })).length > 0;
  return (await clients.matchAll({type:'window',includeUncontrolled:true})).some(c => c.url === engineUrl);
}
async function messageEngine(fields) {
  try { return await chrome.runtime.sendMessage({destination:'hls-engine',...fields}); }
  catch (error) {
    if (error.message === 'Could not establish connection. Receiving end does not exist.') return null;
    throw error;
  }
}

// Every engine registers its listener before accepting work. No receiver in a loaded
// offscreen document means its module did not start; an active engine explicitly answers false.
async function engineIsIdle() {
  const reply = await messageEngine({action:'idle?'});
  return reply == null || reply.idle === true;
}

async function retireIdleEngine() {
  if (!await activeDocument()) return true;
  if (!await engineIsIdle()) return false;
  await chrome.offscreen.closeDocument();
  return true;
}
const sourceOf = job => job.pageSources?.find(s => s.playlistUrl === job.url && s.tabId === job.tabId &&
  httpUrl(s.documentUrl)?.origin === s.origin && httpUrl(s.playlistUrl)?.origin === s.mediaOrigin);
const scriptId = run => 'evs-player-' + run;

// Called with the lifecycle lock, including when replacing an idle engine after an update.
async function sendCommand(page, action, raw, requireRunning, folderCheck) {
  if (folderCheck) {
    const current = await readEntry(page.id);
    if (current.page?.run !== page.run || !matchesFolderCheck(current.state,folderCheck)) return false;
  }
  const exists = await activeDocument();
  if (requireRunning && !exists) return false;
  if (!exists) {
    await chrome.offscreen.createDocument({url:'engine.html', reasons:['IFRAME_SCRIPTING','BLOBS'],
      justification:'元のタブに進捗を表示し、HLSや動画ファイルの取得と保存をバックグラウンドで続けます。'});
  }
  const reply = await messageEngine({action,page,raw,requireRunning,folderCheck});
  if (reply == null) await retireIdleEngine();
  if (!reply?.ok) throw new Error(reply?.error || 'バックグラウンドの取得処理を開始できません。');
  // Earlier engines acknowledged every action, even ones they silently ignored.
  if (action === 'retry-update' && !reply.updateRetry) throw new Error('更新後の取得処理を読み込めませんでした。');
  return reply.handled !== false;
}

function command(page, action, raw = false, requireRunning = false, folderCheck) {
  return lifecycle(() => sendCommand(page,action,raw,requireRunning,folderCheck));
}

function present(page, state) {
  if (!page?.sourcePanel || !state || state.run !== page.run) return;
  // A slow source tab must not hold the disk writer or a queue lock. An important
  // state change is sent immediately; only repeated progress within that stage is coalesced.
  const active = panelUpdates.get(page.run);
  if (active && ['fetching','saving'].includes(state.phase) && active.phase === state.phase &&
      active.saveStage === state.saveStage && active.readerMode === state.readerMode) {
    active.latest = state;
    return;
  }
  const delivery = {phase:state.phase,saveStage:state.saveStage,readerMode:state.readerMode};
  panelUpdates.set(page.run,delivery);
  void sendView(page,state).finally(() => {
    if (panelUpdates.get(page.run) !== delivery) return;
    panelUpdates.delete(page.run);
    if (delivery.latest) present(page,delivery.latest);
  }).catch(() => {});
}

async function sendView(page, state) {
  const phase = state.phase;
  let hint = mp4StatusText(state), caption = phaseLabel(state);
  if (phase === 'fetching' || phase === 'saving') {
    const count = Number.isFinite(state.progress) ? Math.round(state.progress * 100) + '%' : state.progressDetail;
    caption = [phase === 'fetching' ? 'DL中' : caption, count].filter(Boolean).join(' ');
    if (phase === 'fetching') hint = sourceTabHint(page,state,'このタブ');
  }
  if (phase === 'permission') hint = '追加の配信元があります。拡張アイコンの「許可して取得」から続けられます。';
  if (phase === 'queued') hint = '取得を準備しています。';
  if (phase === 'updateRetry' && page.job.pageSources?.length) hint += ' 元のプレーヤーを使う場合に備え、このタブを開いたままお待ちください。';
  if (phase === 'ready') {
    if (state.folderPermission) {
      caption = '保存先の許可待ち';
      hint = 'ダウンロード一覧で「自動保存を許可」を押してください。このタブは閉じられます。';
    } else {
      const later = 'このタブを閉じても「ダウンロード一覧」から保存できます。';
      hint = (state.output?.interruption || state.text?.startsWith('保存')) && hint ? hint + ' ' + later : later;
    }
    const omitted = omissionText(state,1);
    if (omitted) hint += ' ' + omitted;
  }
  if (phase === 'saveQueued') hint += ' このタブを閉じても順番待ちは続きます。';
  if (phase === 'saving' && !['choosing','preparing'].includes(state.saveStage)) hint += ' このタブを閉じても保存は続きます。';
  await chrome.tabs.sendMessage(page.job.tabId, {op:'source-view', id:page.id, run:page.run, started:page.started, url:page.sourceUrl,
    phase, caption, hint, progress:state.progress, progressAt:state.progressAt, partial:!!state.output?.interruption, folderPermission:!!state.folderPermission,
    live:!!state.live, saveStage:state.saveStage, sourceProblem:!!state.sourceProblem, canSkip:!!state.canSkip, inlineSave:true}, {documentId:page.job.sourceDoc});
}

async function recover(page, state) {
  if (!['fetching','saveQueued','saving','queued'].includes(state?.phase)) return;
  const running = await lifecycle(async () => await activeDocument() &&
    (await messageEngine({action:'running?',run:page.run}).catch(() => null))?.running);
  if (running) return;
  if (state.phase === 'saveQueued') return {...state,phase:'ready',backgroundSave:false,saveStage:null,
    text:'保存の順番待ちが中断しました。「保存」で再開できます。',progress:null};
  frameStatus.delete(page.run); readers.delete(page.run);
  await chrome.scripting.unregisterContentScripts({ids:[scriptId(page.run)]}).catch(() => {});
  const clearSpool = () => navigator.locks.request(runLock(page.run), {ifAvailable:true}, lock => lock && dropFiles(page.run));
  if (state.phase === 'saving') {
    const key = 'export-download:' + page.run;
    const download = (await chrome.storage.session.get(key))[key];
    if (Number.isInteger(download)) {
      const [item] = await chrome.downloads.search({id:download});
      if (item?.state === 'in_progress') return;
      await chrome.storage.session.remove(key);
      if (item?.state === 'complete') {
        await clearSpool().catch(() => {});
        return {run:page.run,phase:'saved',text:'動画を保存しました。',progress:null};
      }
    }
    const text = state.saveStage === 'committing' ? '保存の確定中に処理が中断しました。保存先に同名のファイルがあるか確認してから再保存してください。'
      : '保存が中断しました。もう一度保存できます。';
    return {...state,phase:'ready',backgroundSave:false,saveStage:null,text,progress:null};
  }
  await clearSpool().catch(() => {});
  return {run:page.run,phase:'interrupted',text:'バックグラウンドの取得が中断しました。再取得できます。',progress:null};
}

export const inlineEngine = {start:page => command(page,'start'), present, recover};

async function entry(msg) {
  const data = await readEntry(msg.id);
  if (!data.page || data.page.run !== msg.run || data.page.incognito !== !!chrome.extension.inIncognitoContext) throw new Error('この取得はすでに終了しました。');
  return data;
}

const folderChecks = new Map();
const pendingFolderSave = state => state?.phase === 'ready' && !!state.folderSavePending;
const folderCheckFor = state => ({text:state.text,folderSavePending:!!state.folderSavePending});
function saveReadyToFolder(id, run, selectionChanged = false, folderCheck) {
  const prior = folderChecks.get(run);
  if (prior && !selectionChanged) return prior;
  const start = () => startFolderSave(id,run,folderCheck);
  const check = (prior ? prior.then(start,start) : start()).finally(() => {
    if (folderChecks.get(run) !== check) return;
    folderChecks.delete(run);
    if (!folderChecks.size) void checkUpdateRetries();
  });
  folderChecks.set(run,check);
  return check;
}

async function startFolderSave(id, run, folderCheck) {
  const {page,state} = await readEntry(id);
  if (!page || page.run !== run || !matchesFolderCheck(state,folderCheck) || page.incognito !== !!chrome.extension.inIncognitoContext) return;
  let message;
  try {
    if (await getSaveFolder(page.incognito ? 'private' : 'normal')) {
      await command(page,'save-folder',false,false,folderCheck || folderCheckFor(state));
      return;
    }
  } catch (error) {
    message = '保存を開始できませんでした。' + error.message;
  }
  if (message || state.folderSavePending) {
    const next = await finishFolderCheck(id,run,state,message);
    if (next && message) present(page,next);
  }
}

function scheduleFolderSave(id, state) {
  void saveReadyToFolder(id,state.run,false,folderCheckFor(state)).catch(error => console.warn('自動保存を開始できませんでした。',error.name));
}

let restoreFolderChecks = true;
async function startNextUpdateRetry() {
  const scope = !!chrome.extension.inIncognitoContext;
  const entries = (await allEntries(scope)).filter(({page,state}) => state && state.run === page.run);
  let waiting = entries.some(({state}) => state?.phase === 'updateRetry');
  for (const {page,state} of entries) {
    if (restoreFolderChecks && pendingFolderSave(state)) scheduleFolderSave(page.id,state);
    if (!isAcquisitionUpdateFailure(page,state)) continue;
    const next = await reconcileUpdateFailure(page.id,page.run,scope);
    if (next) {
      present(page,next);
      if (next.phase === 'updateRetry') waiting = true;
    }
  }
  restoreFolderChecks = false;
  if (!waiting) {
    if (!checkAgain) retryMayBePending = false;
    return;
  }
  if (folderChecks.size || entries.some(({state}) => pendingFolderSave(state))) return;
  const blockers = entries.filter(({state}) => blocksUpdateRetry(state.phase));
  if (blockers.length) {
    for (const {page,state} of blockers) {
      if (unownedTabAcquisition(page,state)) await recoverBackgroundRun(page.id,page.run,scope,inlineEngine);
    }
    // A lost offscreen document can leave a fetching/saving row behind. Reuse normal
    // run-locked recovery, including Chrome's actual download state, without opening a tab.
    const background = blockers.filter(({page,state}) => page.runner === 'engine' || state.backgroundSave);
    if (background.length && await lifecycle(async () => !await activeDocument() || await engineIsIdle())) {
      for (const {page} of background) await recoverBackgroundRun(page.id,page.run,scope,inlineEngine);
    }
    return;
  }
  let dispatch;
  try {
    await lifecycle(async () => {
      const current = await allEntries(scope);
      if (folderChecks.size || current.some(({page,state}) => state && state.run === page.run && blocksUpdateRetry(state.phase,state.folderSavePending))) return;
      const candidate = current.reverse().find(({page,state}) => state?.phase === 'updateRetry' && page.run === state.run);
      if (!candidate) return;
      // The queue can already show a terminal status while the engine still finalizes a file.
      if (!await retireIdleEngine()) return;
      if (folderChecks.size) return;
      dispatch = candidate.page;
      await sendCommand(dispatch,'retry-update',false,false);
    });
  } catch (error) {
    if (!dispatch) throw error;
    const next = await writeRunState(dispatch.id,dispatch.run,{phase:'failed',progress:null,
      text:'自動再取得を開始できませんでした。' + error.message},'updateRetry');
    if (next) present(dispatch,next);
  }
}

let checkingRetries = false, checkAgain = false, retryMayBePending = true;
async function checkUpdateRetries(foundFailure = false) {
  if (foundFailure) retryMayBePending = true;
  if (!retryMayBePending) return;
  checkAgain = true;
  if (checkingRetries) return;
  checkingRetries = true;
  try {
    while (checkAgain) {
      checkAgain = false;
      try { await startNextUpdateRetry(); }
      catch (error) { console.warn('自動再取得の待機状態を確認できませんでした。',error.name); }
    }
  } finally { checkingRetries = false; }
}

async function saveWaitingInScope(incognito, permissionOnly = false) {
  const waiting = (await allEntries(incognito)).filter(({state}) => state?.phase === 'ready' && (!permissionOnly || state.folderPermission));
  if (await getSaveFolder(incognito ? 'private' : 'normal')) {
    await Promise.all(waiting.map(({page}) => saveReadyToFolder(page.id,page.run,true)));
  } else {
    for (const {page,state} of waiting) {
      if (!state.folderPermission) continue;
      const next = {...state,folderPermission:false,text:'保存先を毎回選ぶ設定です。「保存」で書き出せます。'};
      if (await writeState(page.id,page.run,next,'ready')) await present(page,next);
    }
  }
  return true;
}

async function updateSaveFolders(msg) {
  const incognito = !!chrome.extension.inIncognitoContext, scope = incognito ? 'private' : 'normal';
  let result;
  if (msg.action === 'register') result = await registerSaveFolder(scope, msg.handle);
  else if (msg.action === 'select') result = await selectSaveFolder(scope, msg.id);
  else if (msg.action === 'remove') result = await removeSaveFolder(scope, msg.id);
  else throw new Error('保存先の操作を確認できません。');
  const channel = new BroadcastChannel('embedded-video-save-folder-' + scope);
  channel.postMessage('changed'); channel.close();
  if (result.selectionChanged) await saveWaitingInScope(incognito);
  else if (msg.action === 'register' && !result.changed) {
    const folder = await getSaveFolder(scope);
    if (folder && await msg.handle.isSameEntry(folder) && await folder.queryPermission({mode:'readwrite'}) === 'granted') {
      await saveWaitingInScope(incognito, true);
    }
  }
  return result;
}

async function fromEngine(msg) {
  if (msg.op === 'idle') {
    await lifecycle(retireIdleEngine);
    return checkUpdateRetries();
  }
  const {page,state} = await entry(msg), job = page.job;
  const exporting = state?.backgroundSave && state.phase === 'saving' && ['download','download-state','download-cancel'].includes(msg.op);
  if (page.runner !== 'engine' && !['state','write','finished'].includes(msg.op) && !exporting) throw new Error('このキューで使えない操作です。');
  if (msg.op === 'state') return state;
  if (msg.op === 'gap-setting') return readGapPreference(page.incognito);
  if (msg.op === 'write') {
    const next = await writeRunState(page.id,page.run,msg.state,msg.expectedPhase);
    if (next) present(page,next);
    return !!next;
  }
  if (msg.op === 'permission') { await requireOrigins(msg.urls); return; }
  if (msg.op === 'original') {
    const source = sourceOf(job);
    return source && await originalTarget(job, source);
  }
  if (msg.op === 'frame-start') {
    const source = sourceOf(job);
    if (!source) throw new Error('検出したプレーヤーが見つかりません。');
    await requireOrigins([source.documentUrl]);
    const id = scriptId(page.run);
    if (!(await chrome.scripting.getRegisteredContentScripts({ids:[id]})).length) {
      const match = hostPattern(source.documentUrl).slice(0, -2) + new URL(source.documentUrl).pathname + '*';
      await chrome.scripting.registerContentScripts([{id, matches:[match], js:['serve-read.js','embedded-reader.js'],
        allFrames:true, runAt:'document_start', persistAcrossSessions:false}]);
    }
    frameStatus.set(page.run, {url:source.documentUrl.split('#')[0], status:0});
  } else if (msg.op === 'frame-status') return frameStatus.get(page.run)?.status;
  else if (msg.op === 'frame-end') {
    frameStatus.delete(page.run); readers.delete(page.run);
    await chrome.scripting.unregisterContentScripts({ids:[scriptId(page.run)]}).catch(() => {});
  } else if (msg.op === 'download') {
    if (!msg.blob?.startsWith('blob:' + extensionOrigin + '/')) throw new Error('保存するファイルを確認できません。');
    const download = await chrome.downloads.download({url:msg.blob, filename:msg.filename, conflictAction:'uniquify', saveAs:true});
    await chrome.storage.session.set({['export-download:' + page.run]:download});
    return download;
  } else if (msg.op === 'download-state' || msg.op === 'download-cancel') {
    const key = 'export-download:' + page.run, download = (await chrome.storage.session.get(key))[key];
    if (!Number.isInteger(download) || msg.download !== download) throw new Error('保存状況を確認できません。');
    if (msg.op === 'download-cancel') return chrome.downloads.cancel(download).catch(() => {});
    const [record] = await chrome.downloads.search({id:download});
    return {state:record?.state, error:record?.error};
  } else if (msg.op === 'finished') {
    readers.delete(page.run);
    await chrome.storage.session.remove('export-download:' + page.run);
  }
}

async function action(msg, sender) {
  const {page,state} = await entry(msg);
  if (page.runner !== 'engine' && !['save','save-folder','discard'].includes(msg.action) && !(msg.action === 'cancel' && state.backgroundSave)) return false;
  const source = msg.op === 'source-action';
  if (source) {
    if (sender.tab?.id !== page.job.tabId || sender.frameId !== 0 || sender.documentId !== page.job.sourceDoc ||
        sender.url !== page.sourceUrl || sender.tab.incognito !== page.incognito) return false;
    const top = await chrome.webNavigation.getFrame({tabId:sender.tab.id, frameId:0}).catch(() => null);
    if (top?.url !== page.sourceUrl || top.documentId !== sender.documentId) return false;
  } else if (msg.op === 'popup-resume') {
    if (sender.url !== chrome.runtime.getURL('popup.html') || msg.sourceTabId !== page.job.tabId ||
        state.phase !== 'permission' || !state.permission || !await chrome.permissions.contains(state.permission)) return false;
    return command(page,'retry');
  } else if (msg.op === 'list-action') {
    if (!managerSender(sender) || msg.phase !== state.phase) return false;
  } else if (sender.url !== chrome.runtime.getURL('manager.html?q=' + page.id) || sender.tab?.id !== page.owner) return false;
  if (!source && msg.action === 'cancel' && state.phase === 'updateRetry') {
    const next = await writeRunState(page.id,page.run,{phase:'canceled',text:'自動再取得を中止しました。',progress:null},'updateRetry');
    if (next) present(page,next);
    return !!next;
  }
  if (msg.action === 'open') return handleQueueRequest({op:'queue-open',id:page.id}, sender, inlineEngine);
  if (source && msg.action === 'rescan' && state.sourceProblem && ['failed','interrupted'].includes(state.phase)) {
    await openSourceChoices(page.job, 'recover');
    return true;
  }
  const allowed = { save:['ready'], 'save-folder':['ready'], stop:['fetching'], cancel:['fetching','saveQueued','saving','permission','reader','method'], retry:['failed','interrupted','canceled','permission','reader','method'], 'skip-gaps':['failed'], discard:['ready'] };
  if (msg.action === 'skip-gaps' && (!state.canSkip || page.job.kind !== 'hls')) return false;
  if (msg.action === 'cancel' && state.phase === 'saving' && state.saveStage === 'committing') return false;
  if (!allowed[msg.action]?.includes(state.phase) || (source && !['save','stop','retry','skip-gaps'].includes(msg.action))) return false;
  if (['stop','cancel'].includes(msg.action) && ['fetching','saveQueued','saving'].includes(state.phase)) {
    if (await command(page, msg.action, false, true)) return true;
    if (msg.action === 'cancel' && state.phase === 'saving') {
      const key = 'export-download:' + page.run, download = (await chrome.storage.session.get(key))[key];
      if (Number.isInteger(download)) await chrome.downloads.cancel(download).catch(() => {});
    }
    return recoverBackgroundRun(page.id, page.run, page.incognito, inlineEngine);
  }
  const folderCheck = ['save','save-folder'].includes(msg.action) ? folderCheckFor(state) : undefined;
  return command(page,msg.action,!source && !!msg.raw,false,folderCheck);
}

export function registerEngine() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    let candidate = false, finished = false;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(statusPrefix)) continue;
      const before = change.oldValue?.phase, after = change.newValue?.phase;
      if (after === 'ready' && (['fetching','recording'].includes(before) ||
          (pendingFolderSave(change.newValue) && !pendingFolderSave(change.oldValue)))) {
        scheduleFolderSave(key.slice(statusPrefix.length),change.newValue);
      }
      if (after === 'updateRetry' || (['failed','interrupted'].includes(after) && isUpdateModuleError(change.newValue.text))) candidate = true;
      if (before === 'updateRetry' || (blocksUpdateRetry(before) && !blocksUpdateRetry(after)) ||
          (pendingFolderSave(change.oldValue) && !pendingFolderSave(change.newValue))) finished = true;
    }
    if (candidate || finished) void checkUpdateRetries(candidate);
  });
  chrome.downloads.onChanged.addListener(delta => {
    if (['complete','interrupted'].includes(delta.state?.current)) void checkUpdateRetries();
  });
  void checkUpdateRetries();
  const observeNavigation = details => {
    if (details.tabId !== -1 || details.initiator !== extensionOrigin) return;
    for (const item of frameStatus.values()) if (details.url === item.url) item.status = details.statusCode;
  };
  function listen() {
    const event = chrome.webRequest.onHeadersReceived;
    if (event.hasListener(observeNavigation)) event.removeListener(observeNavigation);
    event.addListener(observeNavigation,{urls:['http://*/*','https://*/*'],types:['sub_frame']});
  }
  listen(); chrome.permissions.onAdded.addListener(listen); chrome.permissions.onRemoved.addListener(listen);
  chrome.runtime.onMessage.addListener((msg,sender,reply) => {
    if (sender.id !== chrome.runtime.id) return;
    let task;
    if (msg?.destination === 'hls-host' && sender.url === engineUrl) task = fromEngine(msg);
    else if (msg?.op === 'save-ready-to-folder') task = managerSender(sender) ? saveWaitingInScope(sender.tab.incognito) : Promise.resolve(false);
    else if (['source-action','engine-action','popup-resume','list-action'].includes(msg?.op)) task = action(msg,sender);
    else return;
    task.then(value => reply({ok:true,value}), error => reply({ok:false,error:error.message,flags:{origins:error.origins,permission:error.permission}}));
    return true;
  });
  self.addEventListener('message', event => {
    const msg = event.data, port = event.ports[0];
    if (port && msg?.op === 'update-save-folders' && event.source?.type === 'window' &&
        event.source.frameType !== 'nested' && event.source.url.split('?')[0] === chrome.runtime.getURL('manager.html')) {
      port.postMessage({received:true});
      event.waitUntil(updateSaveFolders(msg).then(result => port.postMessage(result),
        error => port.postMessage({error:error.message})).finally(() => port.close()));
      return;
    }
    if (!port || event.source?.url !== engineUrl || msg?.op !== 'read-original') return;
    event.waitUntil(globalThis.embeddedVideoServeRead(port, async signal => {
      const {page} = await entry(msg), job = page.job, source = sourceOf(job);
      const target = source && await originalTarget(job, source);
      if (!target || target.documentId !== msg.target.documentId)
        throw Object.assign(new Error('プレーヤーが移動しました。'), {pageUnavailable:true,readerDisconnected:true,retryable:true});
      let cached = readers.get(page.run);
      if (!cached || cached.doc !== target.documentId) {
        const sources = job.pageSources.filter(s => s.documentId === source.documentId && s.documentUrl === source.documentUrl);
        cached = {doc:target.documentId, read:hlsFetchFor(sources.map(s => ({...s,...target})), job.url, () => {
          if (readers.get(page.run) === cached) readers.delete(page.run);
        })};
        readers.set(page.run,cached);
      }
      return cached.read(msg.url, {signal, credentials:'omit', referrerPolicy:'no-referrer',
        headers:msg.range ? {Range:msg.range} : {}, cache:msg.fresh ? 'no-store' : 'default'});
    }));
  });
}
