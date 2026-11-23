import { acquireRun } from './acquire-run.mjs';
import { exportMime, exportName, finishMergeFailure, openExport } from './queue-transfer.mjs';
import { dropFiles, removeExport, runLock, spool } from './queue-files.mjs';
import { acquireSaveSlot, commitStatus, folderLabel, getFolderSettings, selectedFolder, reserveDestination, removeEmptyReservation, saveProgress, saveWaitText, storageSaveText } from './save-folder.mjs';
import { enginePlayer, host } from './engine-player.mjs';
import { matchesFolderCheck } from './queue.mjs';

const tasks = new Map();
let idleTimer;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browserSave(file, filename, ext, rpc, signal, onWriting) {
  const blob = URL.createObjectURL(new File([file], filename, {type:exportMime(ext)}));
  try {
    signal.throwIfAborted();
    const download = await rpc('download', {blob,filename});
    let cancelSent = false;
    for (;;) {
      if (signal.aborted && !cancelSent) {
        cancelSent = true;
        await rpc('download-cancel',{download});
      }
      const item = await rpc('download-state',{download});
      if (item.state === 'complete') return;
      if (item.state !== 'in_progress') {
        if (item.error === 'USER_CANCELED' || signal.aborted) throw new DOMException('保存をキャンセルしました。','AbortError');
        throw new Error('Chromeで保存を完了できませんでした。' + (item.error || ''));
      }
      if (onWriting && !signal.aborted) { await onWriting(); onWriting = null; }
      await delay(350);
    }
  } finally {
    URL.revokeObjectURL(blob);
  }
}

async function save(page, ready, raw, folderOnly, signal, rpc, write) {
  const ext = raw && ready.output.raw ? 'ts' : ready.output.extension;
  const filename = exportName(page,ready.output,ext);
  ready = {...ready,folderPermission:false,backgroundSave:false,saveStage:null,progressDetail:null,destinationName:null};
  let writer, folder, reserved, releaseSlot, temporary = false, phase = 'ready';
  try {
    // Bind the actual handle before publishing saveQueued. Switching or removing a preset cannot redirect this job.
    const settings = await getFolderSettings(page.incognito ? 'private' : 'normal');
    const target = selectedFolder(settings);
    folder = target?.handle;
    if (!folder && folderOnly) {
      await write({...ready,text:'「保存」を押して保存先を選べます。'},phase);
      return;
    }
    const saving = {...ready,phase:'saving',backgroundSave:true,destinationName:target ? folderLabel(settings, target) : null};
    if (!await write({...saving,phase:'saveQueued',text:saveWaitText,progress:null}, phase)) return;
    phase = 'saveQueued';
    releaseSlot = await acquireSaveSlot(signal);
    signal.throwIfAborted();
    if (folder && await folder.queryPermission({mode:'readwrite'}) !== 'granted') {
      throw new DOMException('フォルダーへの書き込み許可が必要です。','NotAllowedError');
    }
    const writing = {...saving,saveStage:folder ? null : 'preparing',
      text:folder ? storageSaveText : '保存先を選ぶ前に、動画ファイルを準備しています。'};
    if (!await write({...writing,progress:0},phase)) return;
    phase = 'saving';
    const output = await openExport(page.run,ext);
    signal.throwIfAborted();
    let file = folder ? null : output.file;
    if (!file) {
      const handle = folder ? (reserved = await reserveDestination(folder,filename,signal)) : await spool(page.run,'export',true);
      temporary = !folder;
      writer = await handle.createWritable();
      const duration = await output.writeTo(writer,signal,saveProgress(progress => {
        void write({...writing,progress},'saving').catch(() => {});
      }));
      if (ready.output.omittedRanges && Number.isFinite(duration)) saving.output = {...ready.output, duration};
      signal.throwIfAborted();
      if (folder && !await write({...saving,...commitStatus},'saving')) throw new DOMException('保存が中断しました。','AbortError');
      signal.throwIfAborted();
      await writer.close(); writer = null;
      if (temporary) file = await handle.getFile();
    }
    if (!folder) {
      await write({...saving,saveStage:'choosing',text:'Chromeで保存先を選んでください。',progress:null});
      await browserSave(file,filename,ext,rpc,signal,() =>
        write({...saving,text:storageSaveText,progress:null},'saving'));
    }
    const savedName = reserved?.name || '動画';
    reserved = null;
    await write({run:page.run,phase:'saved',text:savedName + ' を保存しました。',progress:null,
      ...(ready.output.omittedRanges ? {omittedRanges:ready.output.omittedRanges,
        sourceDuration:ready.output.sourceDuration, duration:saving.output.duration} : {}),
      closeViewer:folder ? page.owner : null, destinationName:saving.destinationName});
    await dropFiles(page.run).catch(() => {});
  } catch (error) {
    if (writer) await writer.abort().catch(() => {});
    if (reserved) await removeEmptyReservation(folder,reserved).catch(() => {});
    if (await finishMergeFailure(page.run,error,ready.output.omittedRanges,next => write(next,'saving'))) return;
    if (error.missingSpool) await write({phase:'interrupted',text:error.message,progress:null});
    else {
      const folderPermission = !!folder && ['NotAllowedError','SecurityError'].includes(error.name);
      const canceled = error.name === 'AbortError' || /cancel(?:ed|led)/i.test(error.message);
      const text = folderPermission ? '保存先「' + folder.name + '」に書き込む許可が必要です。一覧の「自動保存を許可」か、個別キューの「保存先を再許可して保存」を押してください。'
        : canceled ? '保存をキャンセルしました。取得済みの動画は保存待ちです。' : '保存できませんでした。' + error.message;
      await write({...ready,text,folderPermission}, phase);
    }
  } finally {
    if (temporary) await removeExport(page.run).catch(() => {});
    releaseSlot?.();
  }
}

async function perform({page,action,raw,folderCheck}, controller, stop) {
  const key = {id:page.id,run:page.run};
  const rpc = (op, data) => host(op,{...key,...data});
  let previousWrite = Promise.resolve();
  function write(state, expectedPhase) {
    const pending = previousWrite.then(() => rpc('write',{state,expectedPhase}));
    previousWrite = pending.catch(() => {});
    return pending;
  }
  const state = await rpc('state');
  if ((action === 'start' && state.phase === 'queued') ||
      (action === 'retry-update' && state.phase === 'updateRetry') ||
      (action === 'skip-gaps' && page.job.kind === 'hls' && state.phase === 'failed' && state.canSkip) ||
      (action === 'retry' && ['failed','interrupted','canceled','permission','reader','method'].includes(state.phase))) {
    await acquireRun(page,controller,stop,write,{expectedPhase:state.phase,authorize:urls => rpc('permission',{urls}),
      skipGaps:action === 'skip-gaps' || state.resumeWithGaps, previousFailure:state.skipSegment, readGapSetting:() => rpc('gap-setting'),
      openPlayer:(_job,signal,report) => enginePlayer(page,signal,report)}, () => {});
  } else if (action === 'save' || action === 'save-folder' || action === 'discard') {
    await navigator.locks.request(runLock(page.run), async () => {
      const ready = await rpc('state');
      if (!matchesFolderCheck(ready,folderCheck)) return;
      if (action === 'discard') {
        if (await write({phase:'canceled',text:'取得済みの動画を破棄しました。',progress:null},'ready')) await dropFiles(page.run);
      } else await save(page,ready,raw,action === 'save-folder',controller.signal,rpc,write);
    });
  } else if (action === 'cancel' && ['permission','reader','method'].includes(state.phase)) {
    await write({phase:'canceled',text:'取得を中止しました。',progress:null},state.phase);
  }
  await rpc('finished');
}

function start(request) {
  const {page,action,folderCheck} = request;
  clearTimeout(idleTimer);
  const active = tasks.get(page.run);
  if (active) {
    const differentSave = folderCheck && active.folderCheck && (folderCheck.text !== active.folderCheck.text ||
      folderCheck.folderSavePending !== active.folderCheck.folderSavePending);
    if (action === 'stop') active.stop.abort();
    else if (action === 'cancel') active.controller.abort();
    else if (action !== active.action || differentSave) void active.done.then(() => start(request));
    return;
  }
  const task = {action, folderCheck, controller:new AbortController(), stop:new AbortController()};
  tasks.set(page.run,task);
  task.done = perform(request,task.controller,task.stop).catch(async error => {
    const fail = expectedPhase => host('write',{id:page.id,run:page.run,expectedPhase,state:{phase:'failed',progress:null,text:error.message}});
    if (action === 'retry-update') {
      if (!await fail('updateRetry')) await fail('fetching');
    } else await fail();
  }).catch(() => {}).finally(() => {
    tasks.delete(page.run);
    if (!tasks.size) idleTimer = setTimeout(() => { void host('idle').catch(() => {}); }, 1200);
  });
}

chrome.runtime.onMessage.addListener((msg,sender,reply) => {
  if (msg?.destination !== 'hls-engine' || sender.id !== chrome.runtime.id || sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL('background.mjs'))) return;
  if (msg.action === 'running?') { reply({running:tasks.has(msg.run)}); return; }
  if (msg.action === 'idle?') { reply({idle:!tasks.size}); return; }
  if (!msg.page || (msg.page.runner !== 'engine' && !['save','save-folder','discard','cancel'].includes(msg.action))) return;
  if (msg.requireRunning && !tasks.has(msg.page.run)) { reply({ok:true,handled:false}); return; }
  start(msg);
  reply(msg.action === 'retry-update' ? {ok:true,updateRetry:true} : {ok:true});
});
