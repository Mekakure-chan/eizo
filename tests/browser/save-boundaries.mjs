import assert from 'node:assert/strict';
import { openLegacyFile } from './list-actions.mjs';

export const lostReplyCases = ['finishready','finishsaved','readyack','savedack','readyunsent','savedunsent',
  'savedrace','downloadack','downloadpoll','folderunsent'];

// The real offscreen document writes the files. Interrupt one message either
// before delivery or after the worker has committed its result.
export function loseFinishedReply() {
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  let delayed;
  chrome.runtime.sendMessage = async (...args) => {
    const msg = args[0], key = msg?.op === 'write' ? msg.state.phase : msg?.op;
    if (delayed && msg?.id === delayed[0].id && msg.op === 'state') {
      const snapshot = await send(...args);
      const original = delayed;
      delayed = null;
      await send(...original);
      return snapshot;
    }
    if (msg?.destination === 'hls-host' && localStorage.getItem('fixture-lost-finish') === msg.id+'|'+key) {
      localStorage.removeItem('fixture-lost-finish');
      const delivery = localStorage.getItem('fixture-finish-delivery');
      if (delivery === 'delayed') delayed = args;
      else if (delivery !== 'unsent') await send(...args);
      localStorage.setItem('fixture-finish-dropped',msg.run);
      throw Error('Test: completion response lost');
    }
    return send(...args);
  };
}

export async function testFinishedReply({mode,context,base,top,startFromToolbar,worker,until,lastNative,bytes}) {
  const source = await context.newPage(), list = await context.newPage();
  try {
    await source.goto(top+'/file-watch?case='+mode);
    await list.goto(base+'/manager.html');
    const {id,tabId} = await list.evaluate(async url => ({
      id:await (await import('./queue.mjs')).pageId(url),tabId:(await chrome.tabs.query({url}))[0].id
    }),source.url());
    const duringAcquisition = ['finishready','readyack','readyunsent'].includes(mode);
    const automatic = mode === 'folderunsent';
    const key = mode === 'downloadack' ? 'download' : mode === 'downloadpoll' ? 'download-state'
      : mode.startsWith('finish') ? 'finished' : duringAcquisition ? 'ready' : 'saved';
    const arm = () => list.evaluate(({id,key,delivery}) => {
      localStorage.setItem('fixture-lost-finish',id+'|'+key);
      localStorage.setItem('fixture-finish-delivery',delivery);
    },{id,key,delivery:mode === 'savedrace' ? 'delayed' : mode.endsWith('unsent') ? 'unsent' : 'delivered'});
    const entry = () => list.evaluate(async id => (await import('./queue.mjs')).readEntry(id),id);
    async function settled(run) {
      await until(() => list.evaluate(run => localStorage.getItem('fixture-finish-dropped') === run,run),'lost cleanup response');
      await until(() => worker.evaluate(async run => {
        const activity = await chrome.runtime.sendMessage({destination:'hls-engine',action:'running?',run}).catch(() => null);
        return !activity?.running;
      },run),'offscreen operation to leave the active set');
    }
    const downloads = () => worker.evaluate(async () => (await chrome.downloads.search({})).length);
    const before = await downloads();
    if (duringAcquisition || automatic) await arm();
    await startFromToolbar(source,tabId);
    await until(async () => !!(await entry()).page,'new queue');
    const {page} = await entry(), row = list.locator('#list li[data-id="'+id+'"]');
    if (duringAcquisition) {
      await settled(page.run);
      assert.equal((await entry()).state.phase,'ready','a lost cleanup response must preserve the acquired video');
    }
    if (!automatic) {
      await row.locator('.phase[data-state="ready"]').waitFor();
      if (!duringAcquisition) await arm();
      await row.getByRole('button',{name:'保存',exact:true}).click();
    }
    if (!duringAcquisition) {
      await settled(page.run);
      assert.equal((await entry()).state.phase,'saved','a committed file must stay saved after the final reply is lost');
    }
    await row.locator('.phase[data-state="saved"]').waitFor();
    if (automatic) {
      assert.equal(await downloads(),before);
      const files = await list.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('完了通知テスト');
        const files = [];
        for await (const handle of dir.values()) files.push([...new Uint8Array(await (await handle.getFile()).arrayBuffer())]);
        return files;
      });
      assert.deepEqual(files,[[...bytes]]);
    } else {
      assert.equal(await downloads(),before+1);
      assert.deepEqual(await lastNative(),bytes);
    }
    await until(() => list.evaluate(async run => {
      const {spool} = await import('./queue-files.mjs');
      try { await spool(run,'video'); return false; }
      catch (error) { if (error.name === 'NotFoundError') return true; throw error; }
    },page.run),'committed file to release its temporary data',2500);
    console.log(mode,'kept the committed state and saved exactly one complete file');
  } finally {
    await list.evaluate(() => {
      for (const key of ['fixture-lost-finish','fixture-finish-dropped','fixture-finish-delivery']) localStorage.removeItem(key);
    });
    await Promise.all([list.close(),source.close()]);
  }
}

export function serveDirectBody(res, path, video) {
  const mode = path.split('/')[2];
  const samples = {
    problem:['application/problem+json','{"title":"Could not serve media"}'],
    wrongBody:['video/mp4','<!doctype html><title>Media unavailable</title>'],
    onlyInit:['application/octet-stream',video.init],
    cutPayload:['video/mp4',Buffer.concat([video.init,video.media.subarray(0,video.media.lastIndexOf('mdat')+7)])],
    good:['application/octet-stream',Buffer.concat([video.init,video.media])],
    wrongSuffix:['video/mp4',Buffer.concat([video.init,video.media])]
  };
  const [type,content] = samples[mode];
  res.writeHead(200,{'Content-Type':type,'Content-Length':Buffer.byteLength(content)}).end(content);
}

export async function testDirectBodies({context,base,top,until,bytes}) {
  const list = await context.newPage();
  try {
    await list.goto(base+'/manager.html');
    const phases = {};
    for (const mode of ['problem','wrongBody','onlyInit','cutPayload','good','wrongSuffix']) {
      const ext = ['problem','wrongSuffix'].includes(mode) ? 'webm' : 'mp4';
      const url = top+'/direct-body/'+mode+'/sample.'+ext;
      const id = await list.evaluate(async ({mode,ext,url}) => {
        const {openTransfer} = await import('./jobs.mjs');
        await openTransfer({kind:'file',label:mode,extension:ext,url,sourceUrl:url});
        return (await import('./queue.mjs')).pageId(url);
      },{mode,ext,url});
      await until(async () => {
        const state = await list.evaluate(async id => (await (await import('./queue.mjs')).readEntry(id)).state,id);
        return ['failed','mergeFailed','saved'].includes(phases[mode] = state?.phase);
      },'final state for '+mode);
    }
    const files = await list.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('内容検査');
      const entries = {};
      for await (const file of dir.values()) entries[file.name] = [...new Uint8Array(await (await file.getFile()).arrayBuffer())];
      return entries;
    });
    assert.deepEqual(phases,{problem:'failed',wrongBody:'failed',onlyInit:'failed',cutPayload:'failed',good:'saved',wrongSuffix:'saved'});
    assert.deepEqual(files,{'good.mp4':[...bytes],'wrongSuffix.mp4':[...bytes]});
    console.log('rejected non-video and incomplete HTTP 200 responses and saved complete direct files under the reported video format');
  } finally { await list.close(); }
}

export async function testPickerCancel({context,base,top,worker,nextQueue,bytes}) {
  const source = await context.newPage(), list = await context.newPage();
  let owner;
  try {
    await source.goto(top+'/file-watch?case=picker-abort');
    await list.goto(base+'/manager.html');
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,source.url());
    owner = await openLegacyFile(list,source,tabId,nextQueue);
    await owner.locator('#phase[data-state="ready"]').waitFor();
    await owner.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const existing = await root.getFileHandle('user-existing.mp4',{create:true});
      const writer = await existing.createWritable(); await writer.write('original data'); await writer.close();
      window.pickerCalls = 0;
      window.showSaveFilePicker = async () => {
        if (++pickerCalls === 1) return new Promise(resolve => { window.latePicker = () => resolve(existing); });
        if (pickerCalls === 2) return existing;
        return root.getFileHandle('new-choice.mp4',{create:true});
      };
      const create = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = async function(...args) {
        const sink = await create.apply(this,args);
        if (this.name === existing.name) sink.close = async () => { throw Error('fixture commit failure'); };
        return sink;
      };
      // Simulate a second press while the first activation is opening the dialog.
      const save = document.querySelector('#save');
      save.addEventListener('click',() => queueMicrotask(() => save.click()),{once:true});
    });
    const id = new URL(owner.url()).searchParams.get('q'), row = list.locator('#list li[data-id="'+id+'"]');
    await owner.locator('#save').click();
    await row.locator('.phase[data-state="saveQueued"]').waitFor();
    assert.equal(await owner.evaluate(() => pickerCalls),1);
    await row.getByRole('button',{name:'保存を中止',exact:true}).click();
    await row.locator('.phase[data-state="ready"]').waitFor({timeout:2500});
    await owner.locator('#save').click();
    await owner.locator('#status').filter({hasText:'fixture commit failure'}).waitFor();
    const contents = name => owner.evaluate(async name => {
      const root = await navigator.storage.getDirectory();
      return [...new Uint8Array(await (await (await root.getFileHandle(name)).getFile()).arrayBuffer())];
    },name);
    assert.equal(Buffer.from(await contents('user-existing.mp4')).toString(),'original data');
    await owner.locator('#save').click();
    await row.locator('.phase[data-state="saved"]').waitFor();
    await owner.evaluate(() => latePicker());
    assert.equal(await owner.locator('#phase').getAttribute('data-state'),'saved');
    assert.equal(Buffer.from(await contents('user-existing.mp4')).toString(),'original data');
    assert.deepEqual(Buffer.from(await contents('new-choice.mp4')),bytes);
    console.log('canceling a pending picker, a failed overwrite and its late reply preserved the original file and the successful retry');
  } finally {
    if (owner && !owner.isClosed()) {
      await owner.evaluate(() => window.latePicker?.()).catch(() => {});
      await owner.close();
    }
    await Promise.all([list.close(),source.close()]);
  }
}
