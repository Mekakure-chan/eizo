import assert from 'node:assert/strict';

// The previous extension stored just a directory handle under its browsing scope.
export async function seedFolderSetting({scope = 'normal', name = null} = {}) {
  const root = await navigator.storage.getDirectory();
  const handle = name && await root.getDirectoryHandle(name, {create:true});
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('embedded-video-saver-preferences', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('folders');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('folders', 'readwrite'), store = tx.objectStore('folders');
      if (handle) store.put(handle, scope); else store.delete(scope);
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function testLostFolderReply({context,base}) {
  const list = await context.newPage();
  try {
    await list.goto(base+'/manager.html');
    await list.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor();
    await list.evaluate(() => {
      const send = ServiceWorker.prototype.postMessage, timer = window.setTimeout.bind(window);
      window.setTimeout = (callback,ms,...args) => timer(callback,[10000,30000].includes(ms) ? 250 : ms,...args);
      ServiceWorker.prototype.postMessage = function(message,ports) {
        if (message.op !== 'update-save-folders') return send.call(this,message,ports);
        const target = ports[0];
        target.postMessage({received:true});
        if (sessionStorage.getItem('fixture-lost-reply') === 'after-commit') {
          const downstream = new MessageChannel();
          downstream.port1.onmessage = ({data}) => { if (!data.received) downstream.port1.close(); };
          send.call(this,message,[downstream.port2]);
        }
        target.close();
      };
      sessionStorage.setItem('fixture-folder','応答中断テスト');
    });
    await list.locator('#choose-folder').click();
    await list.locator('#folder-feedback').filter({hasText:'保存先の変更'}).waitFor({timeout:4000});
    assert.equal(await list.locator('#folder-presets button:visible').count(),0);
    await list.evaluate(() => {
      sessionStorage.setItem('fixture-lost-reply','after-commit');
      document.querySelector('#folder-feedback').textContent = '以前の操作結果';
    });
    await list.locator('#choose-folder').click();
    await list.locator('#folder-name').filter({hasText:'応答中断テスト'}).waitFor();
    await list.waitForFunction(() => !document.querySelector('#folder-feedback').textContent,null,{timeout:4000});
    assert.equal(await list.locator('#folder-presets button:visible').count(),1);
    console.log('the folder UI recovered from a lost acknowledgment result before and after the real commit');
  } finally { await list.close(); }
}

export async function testFolderPresets({context, base, top, worker, bytes, screenshots}) {
  await worker.evaluate(seedFolderSetting, {name:'旧保存先'});
  await worker.evaluate(seedFolderSetting, {scope:'private', name:'別の閲覧枠'});
  const list = await context.newPage(), other = await context.newPage();
  const selected = (tab, name) => tab.locator('#folder-presets button[aria-pressed="true"]').filter({hasText:name});
  const add = async name => {
    await list.evaluate(value => sessionStorage.setItem('fixture-folder', value), name);
    await list.locator('#choose-folder').click();
  };
  const option = (tab, name) => tab.locator('#folder-presets').getByRole('button', {name, exact:true});
  try {
    await list.goto(base + '/manager.html');
    await other.goto(base + '/manager.html');
    await selected(list, '旧保存先').waitFor({timeout:3500});
    await add('整理用');
    await option(other, '整理用').waitFor();
    assert.equal(await selected(list,'旧保存先').count(), 1);
    await add('整理用');
    await list.locator('#folder-feedback').filter({hasText:'登録済み'}).waitFor();
    assert.equal(await list.locator('#folder-presets button:visible').count(), 2);
    await list.evaluate(() => sessionStorage.setItem('fixture-cancel-folder','1'));
    await list.locator('#choose-folder').click();
    await list.evaluate(() => sessionStorage.removeItem('fixture-cancel-folder'));
    await add('別の場所/整理用');
    await list.waitForFunction(() => document.querySelector('#choose-folder').disabled);
    assert.ok(await list.locator('#choose-folder').isHidden(),'the full register has no unusable add button');
    assert.equal(await selected(list,'旧保存先').count(), 1);
    const choices = list.locator('#folder-presets button:visible');
    const names = await choices.allTextContents();
    assert.equal(new Set(names).size, 3, 'same leaf name in two locations must be distinguishable');
    assert.ok(names[1].includes('整理用') && names[2].includes('整理用'));

    // Hold the real destination lock and change folders while both jobs are queued.
    await other.evaluate(async () => {
      await new Promise(locked => {
        void navigator.locks.request('embedded-video-saver/export/0', () => new Promise(release => {
          window.releaseFolderWriter = release;
          locked();
        }));
      });
    });
    async function enqueue(label) {
      const sourceUrl = top + '/destinations/' + label;
      await list.evaluate(async ({label, sourceUrl, top}) => {
        const {openTransfer} = await import('./jobs.mjs');
        await openTransfer({kind:'file', label, extension:'mp4', url:top+'/clip.mp4', sourceUrl});
      }, {sourceUrl, label, top});
      const row = list.locator('#list li').filter({hasText:label});
      await row.locator('.phase[data-state="saveQueued"]').waitFor();
      return row;
    }
    const a = await enqueue('folder-job-A');
    await option(list, names[2]).click();
    await selected(other, names[2]).waitFor();
    const b = await enqueue('folder-job-B');
    await list.locator('#clear-folder').click();
    await other.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor();
    await list.reload();
    await list.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor();
    assert.equal(await choices.count(), 3);
    await other.evaluate(() => releaseFolderWriter());
    for (const row of [a,b]) await row.locator('.phase[data-state="saved"]').waitFor();
    const saved = await list.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const one = await root.getDirectoryHandle('旧保存先'), two = await root.getDirectoryHandle('整理用');
      const three = await (await root.getDirectoryHandle('別の場所')).getDirectoryHandle('整理用');
      return Promise.all([one,two,three].map(async dir => {
        const files = {};
        for await (const handle of dir.values()) files[handle.name] = Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
        return files;
      }));
    });
    assert.deepEqual(saved, [{'folder-job-A.mp4':[...bytes]}, {}, {'folder-job-B.mp4':[...bytes]}]);
    await option(list, names[2]).click();
    await list.reload();
    await selected(list, names[2]).waitFor();
    await list.setViewportSize({width:320,height:680});
    assert.ok(await list.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (screenshots) await list.screenshot({path:screenshots + '/folder-presets.png'});
    await list.locator('#manage-folders summary').click();
    await list.locator('#registered-folders').getByRole('button',{name:names[2] + 'の登録を解除',exact:true}).click();
    await other.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor();
    assert.ok(await list.locator('#choose-folder').isEnabled());
    assert.ok(await list.locator('#choose-folder').isVisible());
    const registerFrom = (tab, name) => tab.evaluate(async name => {
      const {registerSaveFolder} = await import('./save-folder.mjs');
      const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle(name,{create:true});
      await registerSaveFolder('normal',handle);
    }, name);
    const attempts = await Promise.allSettled([registerFrom(list,'追加A'), registerFrom(other,'追加B')]);
    assert.deepEqual(attempts.map(r => r.status).sort(), ['fulfilled','rejected']);
    assert.match(attempts.find(r => r.status === 'rejected').reason.message, /3か所/);
    assert.deepEqual(await list.evaluate(async () => {
      const {getFolderSettings, getSaveFolder} = await import('./save-folder.mjs');
      const settings = await getFolderSettings('normal');
      return [settings.slots.filter(Boolean).length, settings.activeId, (await getSaveFolder('private')).name];
    }), [3,null,'別の閲覧枠']);
    const kept = await list.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('別の場所')).getDirectoryHandle('整理用');
      return (await (await dir.getFileHandle('folder-job-B.mp4')).getFile()).size;
    });
    assert.equal(kept, bytes.length, 'removing a registration keeps the exported file');
    console.log('three persistent folders, legacy migration, manual mode, duplicate names, concurrent cap and queued destinations verified');
  } finally {
    await other.evaluate(() => window.releaseFolderWriter?.()).catch(() => {});
    await list.close(); await other.close();
  }
}
