import assert from 'node:assert/strict';
import {seedFolderSetting} from './folder-presets.mjs';

export async function testMissingAudio({context,base,cdn,nextQueue}) {
  const index = await context.newPage();
  let queue;
  try {
    await index.goto(base+'/manager.html');
    const next = nextQueue();
    await index.evaluate(async job => (await import('./jobs.mjs')).openTransfer(job),
      {kind:'hls',label:'missingtrack',url:cdn+'/missingtrack/playlist.m3u8'});
    queue = await next;
    await queue.locator('#phase:is([data-state="failed"],[data-state="mergeFailed"])').waitFor();
    assert.equal(await queue.locator('#phase').innerText(),'結合に失敗しました');
    assert.match(await queue.locator('#status').innerText(),/音声トラック/);
    assert.ok(await queue.locator('#retry').isHidden());
    console.log('missing audio track ended at the merge check before offering to save');
  } finally {
    if (queue && !queue.isClosed()) await queue.close();
    await index.close();
  }
}

export async function testMergeFailure({mode,context,worker,base,top,cdn,nextQueue,startFromToolbar,panelView,expectTabIcon,until}) {
  const automatic = mode === 'joinfailauto';
  const folderName = '結合エラーのテスト';
  const url = cdn + '/' + mode + '/1080p/video.m3u8';
  const index = await context.newPage();
  const dialogs = [];
  const onDialog = async dialog => {
    dialogs.push(dialog.type());
    await dialog.dismiss();
  };
  if (automatic) context.on('dialog',onDialog);
  let source, queue, tabId;
  try {
    await index.goto(base+'/manager.html');
    if (automatic) {
      await worker.evaluate(seedFolderSetting, {name:folderName});
      source = await context.newPage();
      await source.goto(top+'/watch?case='+mode);
      await source.evaluate(async ({url,mode}) => { document.title=mode; await (await fetch(url)).text(); },{url,mode});
      tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,source.url());
      await startFromToolbar(source,tabId);
    } else {
      const next = nextQueue();
      await index.evaluate(async job => (await import('./jobs.mjs')).openTransfer(job), {kind:'hls',label:mode,url});
      queue = await next;
      await queue.locator('#phase[data-state="ready"]').waitFor();
      await queue.evaluate(async () => {
        const file = await (await navigator.storage.getDirectory()).getFileHandle('kept.mp4',{create:true});
        const writer = await file.createWritable(); await writer.write('existing file'); await writer.close();
        window.showSaveFilePicker = async () => file;
      });
      await queue.locator('#save').click();
    }

    // Include the old state so this fails on the actual ready-to-save regression.
    const row = index.locator('#list li').filter({hasText:mode});
    await row.getByText(/Timestamps cannot be smaller|結合に失敗しました/).first().waitFor();
    const {state,page} = await index.evaluate(async url =>
      (await (await import('./queue.mjs')).allEntries(false)).find(item => item.page.job.url === url),url);
    assert.equal(state.phase,'mergeFailed',state.text);
    assert.match(state.text,/再生時刻/);
    assert.match(state.omittedRanges.join(' '),/2\/3 区間目/);
    await row.locator('.phase[data-group="stopped"]').waitFor();
    assert.match(await row.innerText(),/結合に失敗しました/);
    assert.equal(await row.getByRole('button',{name:/保存|再取得/}).count(),0);
    if (automatic) {
      await source.waitForFunction(() => document.title.startsWith('結合に失敗しました'));
      assert.deepEqual((await panelView(tabId)).buttons,['キューを開く']);
      await expectTabIcon(tabId,'error');
      const names = await index.evaluate(async name => {
        const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        return Array.fromAsync(dest.keys());
      },folderName);
      assert.deepEqual(names,[]);
    } else {
      await queue.locator('#phase[data-state="mergeFailed"]').waitFor();
      assert.ok(await queue.locator('#save').isHidden());
      assert.ok(await queue.locator('#retry').isHidden());
      assert.equal(await queue.evaluate(async () => {
        const file = await (await navigator.storage.getDirectory()).getFileHandle('kept.mp4');
        return (await file.getFile()).text();
      }), 'existing file');
    }
    await until(() => index.evaluate(async run => {
      const root = await navigator.storage.getDirectory(), folder = await root.getDirectoryHandle('download-queue-v1');
      try { await folder.getDirectoryHandle(run); return false; }
      catch (e) { if (e.name !== 'NotFoundError') throw e; }
      return navigator.locks.request('embedded-video-saver/export/0',{ifAvailable:true}, lock => !!lock);
    },page.run),'temporary files and save slot to be released');
    if (automatic) {
      // A second real job can acquire the released slot and commit to the same folder.
      await index.evaluate(async job => (await import('./jobs.mjs')).openTransfer(job),{
        kind:'file',label:'after-merge-failure',url:top+'/clip.mp4',extension:'mp4'
      });
      await until(() => index.evaluate(async name => {
        const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        try { return (await (await dest.getFileHandle('after-merge-failure.mp4')).getFile()).size > 0; }
        catch (e) { if (e.name !== 'NotFoundError') throw e; return false; }
      },folderName),'next automatic save to finish');
      assert.deepEqual(dialogs,[],'an individual merge failure must not prompt before the next save');
    }
    console.log(mode,'ended once, kept the destination intact and released its temporary files and save slot');
  } finally {
    if (automatic) context.off('dialog',onDialog);
    if (queue && !queue.isClosed()) await queue.close();
    if (source) await source.close();
    await index.close();
  }
}
