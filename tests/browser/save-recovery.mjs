import assert from 'node:assert/strict';
import { openLegacyFile } from './list-actions.mjs';

export async function testCleanupRetry({context, base, top, bytes}) {
  const probe = await context.newPage();
  try {
    await probe.goto(base + '/transfer.html');
    const result = await probe.evaluate(async top => {
      const {acquireRun} = await import('./acquire-run.mjs');
      const {cleanQueueFiles, dropFiles, runLock, spool} = await import('./queue-files.mjs');
      const {pageId, pagePrefix, readEntry, statusPrefix, writeState} = await import('./queue.mjs');
      const sourceUrl = top + '/cleanup-retry', id = await pageId(sourceUrl);
      const run = crypto.randomUUID(), orphan = crypto.randomUUID();
      const page = {id, run, sourceUrl, started:Date.now(), incognito:false, runner:'tab',
        job:{kind:'file', url:top + '/clip.mp4', extension:'mp4', label:'再取得テスト'}};
      async function video(key) {
        try {
          const file = await (await spool(key,'video')).getFile();
          return Array.from(new Uint8Array(await file.arrayBuffer()));
        }
        catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
      }
      const interrupted = {[statusPrefix + id]:{run, phase:'interrupted'}};
      const retryVideo = (expectedPhase = 'interrupted') => acquireRun(page, new AbortController(), new AbortController(),
        (next, expected) => writeState(id,run,next,expected), {expectedPhase}, error => { throw error; });
      const snapshot = async () => ({state:(await readEntry(id)).state, video:await video(run)});
      const locks = navigator.locks, request = locks.request.bind(locks);
      const remove = FileSystemDirectoryHandle.prototype.removeEntry;
      try {
        await chrome.storage.session.set({[pagePrefix + id]:page, ...interrupted});
        for (const key of [run, orphan]) {
          const writer = await (await spool(key,'video',true)).createWritable();
          await writer.write(new Uint8Array([1])); await writer.close();
        }
        // A real retry completes after cleanup lists the interrupted run but before it locks the files.
        let retry = true;
        locks.request = async (name, ...args) => {
          if (retry && name === runLock(run)) {
            retry = false;
            await retryVideo();
          }
          return request(name, ...args);
        };
        await cleanQueueFiles();
        const first = await snapshot();
        delete locks.request;
        await chrome.storage.session.set(interrupted);
        await spool(run,'video',true);
        // Reverse the order: the user presses retry while the old files are being removed.
        let retrying;
        FileSystemDirectoryHandle.prototype.removeEntry = function(name, options) {
          if (name === run && this.name === 'download-queue-v1' && !retrying) retrying = Promise.all([retryVideo(), retryVideo()]);
          return remove.call(this, name, options);
        };
        await cleanQueueFiles();
        if (!retrying) throw Error('cleanup did not reach the interrupted run');
        await retrying;
        const second = await snapshot(), transfers = performance.getEntriesByName(page.job.url).length;
        // An unsuccessful retry returns to the same phase. A concurrent click must still be consumed only once.
        page.job.url = top + '/unavailable-video';
        await chrome.storage.session.set({[pagePrefix + id]:page, [statusPrefix + id]:{run, phase:'failed'}});
        await Promise.all([retryVideo('failed'), retryVideo('failed')]);
        return {first, second, orphan:await video(orphan), transfers, failed:(await readEntry(id)).state.phase,
          failedTransfers:performance.getEntriesByName(page.job.url).length};
      } finally {
        delete locks.request;
        FileSystemDirectoryHandle.prototype.removeEntry = remove;
        await Promise.all([dropFiles(run), dropFiles(orphan), chrome.storage.session.remove([pagePrefix + id, statusPrefix + id])]);
      }
    }, top);
    assert.equal(result.first.state.phase, 'ready', result.first.state.text);
    assert.ok(result.first.video, 'cleanup deleted the video after the retry reached ready');
    assert.deepEqual(Buffer.from(result.first.video), bytes);
    assert.equal(result.second.state.phase, 'ready', 'retry was lost while cleanup held the file lock');
    assert.deepEqual(Buffer.from(result.second.video), bytes);
    assert.equal(result.transfers, 2, 'two simultaneous requests for the second retry should download the file once');
    assert.equal(result.failed, 'failed');
    assert.equal(result.failedTransfers, 1, 'simultaneous retries must issue one request even if that request fails');
    assert.equal(result.orphan, null, 'abandoned video should still be removed');
    console.log('cleanup retained a completed retry byte for byte and removed an abandoned video');
  } finally { await probe.close(); }
}

export async function testSlowPanel({context,base,top,cdn,worker,startFromToolbar,panelView,until,bytes}) {
  const original = await context.newPage();
  const index = await context.newPage();
  const targetFolder = '通知遅延の検証';
  try {
    await original.goto(top+'/watch?case=slow-panel');
    await original.evaluate(async url=>{document.title='通知遅延テスト'; await (await fetch(url)).text();},cdn+'/savelimit/1080p/video.m3u8');
    const tabId = await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,original.url());
    await until(()=>worker.evaluate(async id=>(await chrome.action.getBadgeText({tabId:id}))==='HLS',tabId),'HLS detected');
    await startFromToolbar(original,tabId);
    await original.waitForFunction(()=>document.title.startsWith('保存待ち'));
    await index.goto(base+'/manager.html');
    const row=index.locator('#list li').filter({hasText:'通知遅延テスト'});
    await row.locator('.phase[data-state="ready"]').waitFor();
    const queueId = await row.getAttribute('data-id');
    const showRoute = hint => worker.evaluate(async ({id,hint}) => {
      const key = 'download-page:' + id, page = (await chrome.storage.session.get(key))[key];
      await chrome.tabs.sendMessage(page.job.tabId, {op:'source-view', id, run:page.run, started:page.started,
        url:page.sourceUrl, phase:'fetching', caption:'DL中 0%', hint, progress:0}, {documentId:page.job.sourceDoc});
    }, {id:queueId,hint});
    // The route hint can change between aiming at the button and pressing the mouse.
    await showRoute('取得方法を確認しています。このタブはそのままでお待ちください。');
    const before = (await panelView(tabId,'キューを開く')).point;
    await showRoute('このタブは閉じられます。');
    const after = (await panelView(tabId,'キューを開く')).point;
    assert.ok(before && after);
    assert.deepEqual(after,before,'changing the real route hint must not move the queue button under the pointer');
    // The player can remain open but slow to acknowledge a status message. Only the UI reply is held.
    await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{
      const pending=[];
      const hold=(message,_sender,reply)=>{
        if(message.op!=='source-view')return;
        pending.push(reply); return true;
      };
      chrome.runtime.onMessage.addListener(hold);
      globalThis.fixtureReleasePanel=()=>{
        chrome.runtime.onMessage.removeListener(hold);
        for(const reply of pending)reply();
        return pending.length;
      };
    }}),tabId);
    await index.evaluate(name=>sessionStorage.setItem('fixture-folder',name),targetFolder);
    await index.locator('#choose-folder').click();
    try {
      await row.locator('.phase[data-state="saved"]').waitFor({timeout:3500});
    } catch (error) {
      throw new Error('Disk save waited for a source-panel acknowledgment; last state: '+await row.locator('.phase').innerText(),{cause:error});
    } finally {
      const [released]=await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>fixtureReleasePanel()}),tabId);
      assert.ok(released.result>=1,'at least one real source-view reply was held');
    }
    await original.waitForFunction(()=>document.title.startsWith('保存済み'));
    const result=await index.evaluate(async name=>{
      const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
      const file=await (await dir.getFileHandle('通知遅延テスト.mp4')).getFile();
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    },targetFolder);
    assert.deepEqual(Buffer.from(result),bytes);
    console.log('saved a complete real HLS file while the source panel withheld its replies');
  } finally {
    if (await index.locator('#clear-folder').isVisible()) {
      await index.locator('#clear-folder').click();
      await index.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor();
    }
    await index.close();await original.close();
  }
}

export async function testQueuedRecovery({context, base, top, worker, nextQueue, bytes}) {
  const original = await context.newPage(), index = await context.newPage();
  const folderName = '書き出し復旧テスト';
  try {
    await original.goto(top + '/file-watch?case=queue-recovery');
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, original.url());
    await index.goto(base + '/manager.html');
    const owner = await openLegacyFile(index,original,tabId,nextQueue);
    await owner.locator('#phase[data-state="ready"]').waitFor();
    await original.close();
    await owner.close();
    await index.bringToFront();
    const row = index.locator('#list li').filter({hasText:'case=queue-recovery'});
    await row.locator('.phase[data-state="ready"]').waitFor();
    await index.evaluate(async name => {
      sessionStorage.setItem('fixture-folder', name);
      await new Promise(resolve => {
        void navigator.locks.request('embedded-video-saver/export/0', () => {
          resolve();
          return new Promise(() => {}); // Reloading the list releases the test lock.
        });
      });
    }, folderName);
    await index.locator('#choose-folder').click();
    await row.locator('.phase[data-state="saveQueued"]').waitFor();
    await worker.evaluate(() => chrome.offscreen.closeDocument());
    await index.reload();
    try { await row.locator('.phase[data-state="ready"]').waitFor({timeout:5000}); }
    catch (error) { throw new Error('List did not recover the terminated background export: ' + await row.innerText(), {cause:error}); }
    await row.getByRole('button', {name:'保存',exact:true}).click();
    await row.locator('.phase[data-state="saved"]').waitFor();
    const output = await index.evaluate(async name => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
      const files = [];
      for await (const file of dir.values()) files.push(Array.from(new Uint8Array(await (await file.getFile()).arrayBuffer())));
      return files;
    }, folderName);
    assert.equal(output.length,1);
    assert.deepEqual(Buffer.from(output[0]),bytes);
    console.log('reopened only the download list after losing the waiting background writer and saved the original bytes once');
  } finally {
    if (await index.locator('#clear-folder').isVisible()) {
      await index.locator('#clear-folder').click();
      await index.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor();
    }
    await index.close();
    if (!original.isClosed()) await original.close();
  }
}
