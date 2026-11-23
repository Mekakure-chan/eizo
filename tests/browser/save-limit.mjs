import assert from 'node:assert/strict';

// Hold a chunk or the final commit so the test can inspect active writers across tabs.
export function holdTestExports() {
  if (location.protocol !== 'chrome-extension:') return;
  const create = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = async function(...args) {
    const writer = await create.apply(this, args);
    if (!this.name.startsWith('parallel-export-')) return writer;
    // Observe the whole writer lifetime without serializing writers in the test.
    let finished;
    const lifetime = new Promise(resolve => { finished = resolve; });
    await new Promise((started, reject) => {
      navigator.locks.request('fixture-open-destination', {ifAvailable:true}, lock => {
        if (!lock) localStorage.setItem('fixture-writers-overlapped', 'yes');
        started();
        if (lock) return lifetime;
      }).catch(reject);
    });
    const name = this.name, close = writer.close.bind(writer);
    const write = writer.write.bind(writer);
    const abort = writer.abort.bind(writer);
    writer.abort = async (...args) => {
      try { return await abort(...args); } finally { finished(); }
    };
    writer.write = async chunk => {
      await write(chunk);
      await navigator.locks.request('fixture-write/' + name, () => {});
    };
    writer.close = async () => {
      await navigator.locks.request('fixture-commit/' + name, () => {});
      if (localStorage.getItem('fixture-failed-export') === name) {
        localStorage.removeItem('fixture-failed-export');
        throw Error('テスト用の保存失敗');
      }
      await close();
      finished();
    };
    return writer;
  };
}

export async function testSaveLimit({context, base, top, cdn, nextQueue, startFromToolbar, expectTabIcon, until, bytes}) {
  const index = await context.newPage(); await index.goto(base + '/manager.html');
  const jobs = [];
  let hlsSource;
  const names = Array.from({length:9}, (_, i) => 'parallel-export-' + (i + 1) + '.mp4');
  await index.evaluate(async names => {
    localStorage.removeItem('fixture-writers-overlapped');
    window.releaseCommit = new Map();
    for (const name of names) {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      const holding = new Promise(started => {
        void navigator.locks.request('fixture-commit/' + name, () => { started(); return promise; });
      });
      await holding;
      releaseCommit.set(name,release);
    }
    await new Promise(locked => {
      void navigator.locks.request('fixture-picker/'+names[0],() => new Promise(resolve => {
        window.releasePicker = resolve; locked();
      }));
    });
    await new Promise(locked => {
      void navigator.locks.request('fixture-write/'+names.at(-1),() => new Promise(resolve => {
        window.releaseWrite = resolve; locked();
      }));
    });
  },names);
  async function snapshot() {
    return index.evaluate(async ids => {
      const records = await chrome.storage.session.get(ids.map(id => 'download-state:' + id));
      const {pending} = await navigator.locks.query();
      return {
        writing: pending.filter(e => e.name.startsWith('fixture-commit/')).map(e => e.name.slice('fixture-commit/'.length)),
        states: ids.map(id => records['download-state:' + id])
      };
    },jobs.map(j => j.id));
  }
  const release = name => index.evaluate(name => releaseCommit.get(name)(),name);
  try {
    for (const name of names.slice(0,-1)) {
      const [page] = await Promise.all([nextQueue(), index.evaluate(async ({top,name}) => {
        const {openTransfer} = await import('./jobs.mjs');
        await openTransfer({kind:'file',label:name.slice(0,-4),url:top+'/clip.mp4',extension:'mp4',sourceUrl:top+'/batch/'+name});
      },{top,name})]);
      await page.locator('#phase[data-state="ready"]').waitFor();
      jobs.push({page,id:new URL(page.url()).searchParams.get('q')});
    }
    await jobs[0].page.locator('#save').click();
    await jobs[0].page.locator('#phase').filter({hasText:'保存先を選択中'}).waitFor();
    assert.equal(await jobs[0].page.locator('#phase').getAttribute('data-group'),'attention');
    const manualTab = await jobs[0].page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    await expectTabIcon(manualTab,'waiting');
    await index.evaluate(() => releasePicker());
    await until(async () => (await snapshot()).writing.includes(names[0]),'manual file picker export writing');
    await index.evaluate(() => sessionStorage.setItem('fixture-folder','同時保存テスト'));
    await index.locator('#choose-folder').click();
    await until(async () => (await snapshot()).states.every(s => ['saving','saveQueued'].includes(s?.phase)),'the batch entered the save queue');
    // Acquire another video from its source tab while the destination is saturated.
    hlsSource = await context.newPage();
    await hlsSource.goto(top + '/watch?case=save-limit-hls');
    await hlsSource.evaluate(async ({playlist,name}) => {
      document.title = name.slice(0,-4);
      await (await fetch(playlist)).text();
    },{playlist:cdn+'/savelimit/1080p/video.m3u8',name:names.at(-1)});
    const {tabId,id} = await index.evaluate(async url => {
      const [tab] = await chrome.tabs.query({url});
      return {tabId:tab.id,id:await (await import('./queue.mjs')).pageId(url)};
    },hlsSource.url());
    await until(() => index.evaluate(async id => (await chrome.action.getBadgeText({tabId:id})) === 'HLS',tabId),'HLS detected while exports are busy');
    await startFromToolbar(hlsSource,tabId);
    jobs.push({id});
    await until(async () => {
      const {writing,states} = await snapshot();
      return writing.length > 0 && writing.length + states.filter(s => s?.phase === 'saveQueued').length === 9;
    },'every export either writing or queued');
    const initial = await snapshot();
    assert.deepEqual(initial.writing,[names[0]],'the manual writer must be the only active writer across all tabs and automatic saves');
    for (const name of initial.writing) {
      const s = initial.states[names.indexOf(name)];
      assert.equal(s.saveStage,'committing','closing a destination is a distinct stage for both manual and automatic exports');
      assert.equal(s.progress,null);
    }
    assert.equal(await jobs[0].page.locator('#phase').innerText(),'保存を確定中');
    await expectTabIcon(manualTab,'writing');
    assert.ok(await jobs[0].page.locator('#cancel').isHidden(),'a commit already in progress cannot be canceled');
    const queued = jobs.filter((_,i) => initial.states[i].phase === 'saveQueued');
    assert.equal(queued.length,8);
    await index.locator('#list-filters [data-filter="queued"]').click();
    await until(async () => await index.locator('#list .phase').filter({hasText:'書き出し待ち'}).count() === 8,'eight waiting labels in the list');
    assert.equal(await index.locator('#list li').count(),8,'jobs waiting for disk do not count as active writers');
    await index.locator('#list-filters [data-filter="all"]').click();
    await hlsSource.waitForFunction(() => document.title.startsWith('書き出し待ち'));
    await expectTabIcon(tabId,'waiting');
    const rowFor = job => index.locator('#list li[data-id="' + job.id + '"]');

    const canceled = queued[0];
    await rowFor(canceled).getByRole('button',{name:'保存を中止',exact:true}).click();
    await canceled.page.locator('#phase[data-state="ready"]').waitFor();
    await queued[1].page.close();
    await release(names[0]);
    await until(async () => {
      const {writing,states} = await snapshot();
      return writing.length === 1 && states[0].phase === 'saved';
    },'one completed export making room for the next');
    const [failName] = (await snapshot()).writing;
    await index.evaluate(name => localStorage.setItem('fixture-failed-export',name),failName);
    await release(failName);
    const failedIndex = names.indexOf(failName), failed = jobs[failedIndex];
    await until(async () => (await snapshot()).states[failedIndex].text.includes('テスト用の保存失敗'),'the failed job remains available for retry');
    await until(async () => {
      const {writing} = await snapshot();
      return writing.length === 1 && !writing.includes(failName);
    },'another export starting as soon as one write fails');
    const last = names.at(-1), hlsRow = rowFor(jobs.at(-1));
    await index.evaluate(hold => { for (const [name,open] of releaseCommit) if (name !== hold) open(); },last);
    await hlsSource.waitForFunction(() => document.title.startsWith('保存中'));
    await expectTabIcon(tabId,'writing');
    await index.evaluate(() => releaseWrite());
    await until(async () => (await snapshot()).writing.includes(last),'HLS writing to the preset folder');
    await hlsRow.locator('.phase[data-state="saving"]').waitFor();
    await hlsSource.waitForFunction(() => document.title.startsWith('保存を確定中'));
    await expectTabIcon(tabId,'writing');
    assert.equal(await hlsRow.locator('.phase').innerText(),'保存を確定中');
    assert.equal(await hlsRow.getByRole('button',{name:'保存を中止',exact:true}).count(),0);
    const staleCancel = await index.evaluate(async id => {
      const key='download-state:'+id, {run}= (await chrome.storage.session.get(key))[key];
      return chrome.runtime.sendMessage({op:'list-action',id,run,phase:'saving',action:'cancel'});
    },jobs.at(-1).id);
    assert.equal(staleCancel.value,false,'a stale cancel click cannot interrupt the final commit');
    await index.setViewportSize({width:360,height:800});
    assert.ok(await index.evaluate(() => document.documentElement.scrollWidth <= innerWidth),'row actions fit a narrow list');
    const closeSource = hlsRow.getByRole('button',{name:'元タブを閉じる',exact:true});
    await closeSource.focus();
    await Promise.all([hlsSource.waitForEvent('close'),closeSource.press('Enter')]);
    assert.equal(await hlsRow.locator('.phase').getAttribute('data-state'),'saving');
    await release(last);
    await until(async () => (await snapshot()).states.filter(s => s.phase === 'saved').length === 7,'seven uninterrupted exports');
    for (const job of [failed,canceled]) await rowFor(job).getByRole('button',{name:'保存',exact:true}).click();
    await until(async () => (await snapshot()).states.every(s => s.phase === 'saved'),'all nine videos saved').catch(async error => {
      const remaining = (await snapshot()).states.filter(s => s.phase !== 'saved').map(s => [s.phase,s.text]);
      throw new Error(error.message + ': ' + JSON.stringify(remaining) + ' ' + (await index.locator('.row-error:visible').allTextContents()).join(', '));
    });
    const result = await index.evaluate(async names => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('同時保存テスト'), saved = [];
      for await (const file of dir.values()) saved.push(file.name);
      const files = [];
      for (const [i,name] of names.entries()) {
        const f = await (await (i ? dir : root).getFileHandle(name)).getFile();
        files.push(Array.from(new Uint8Array(await f.arrayBuffer())));
      }
      return {saved,files,overlapped:localStorage.getItem('fixture-writers-overlapped')};
    },names);
    assert.deepEqual(result.saved.sort(),names.slice(1).sort());
    assert.equal(result.overlapped,null,'destination writers must never overlap, including the final commit and abort');
    for (const file of result.files) assert.deepEqual(Buffer.from(file),bytes);
    console.log('9 exports: 1 writing, 8 queued; completed, failed, canceled, closed and retried without duplicate files');
  } finally {
    await index.evaluate(() => { window.releasePicker?.(); window.releaseWrite?.(); for (const open of releaseCommit.values()) open(); }).catch(() => {});
    if (await index.locator('#clear-folder').isVisible()) {
      await index.locator('#clear-folder').click();
      await index.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor();
    }
    if (hlsSource && !hlsSource.isClosed()) await hlsSource.close();
    for (const job of jobs) if (job.page && !job.page.isClosed()) await job.page.close();
    await index.close();
  }
}
