import assert from 'node:assert/strict';
import path from 'node:path';

const button = (row,name) => row.getByRole('button',{name,exact:true});
const phase = (row,name) => row.locator('.phase[data-state="' + name + '"]').waitFor();

// Queues created by older versions may have a source tab but no bound document.
export async function openLegacyFile(index, src, tabId, nextQueue) {
  const source = new URL(src.url()), media = new URL('/clip.mp4',source);
  media.search = source.searchParams.has('variant') ? source.search : '';
  const next = nextQueue();
  await index.evaluate(async job => (await import('./jobs.mjs')).openTransfer(job),
    {kind:'file', label:'clip', extension:'mp4', url:media.href, sourceUrl:source.href, tabId});
  return next;
}

export async function testDirectInline({context,base,top,worker,startFromToolbar,panelView,until,release,managerCount,bytes}) {
  const src = await context.newPage(), index = await context.newPage();
  const before = managerCount();
  try {
    await index.goto(base+'/manager.html');
    await src.goto(top+'/file-watch?variant=list-held&case=directinline');
    const url = src.url(), tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,url);
    const entry = () => index.evaluate(async url => {
      const {pageId,readEntry} = await import('./queue.mjs');
      return readEntry(await pageId(url,false));
    },url);
    await startFromToolbar(src,tabId);
    await until(async () => (await entry()).state?.phase === 'fetching','the direct transfer to start');
    const first = (await entry()).page;
    assert.equal(first.runner,'engine','direct videos from the toolbar must run independently of both tabs');
    await until(async () => (await panelView(tabId))?.hint.includes('閉じられます'),'the source to show when it is safe to close');
    await startFromToolbar(src,tabId);
    await until(() => worker.evaluate(async () => !(await chrome.runtime.getContexts({contextTypes:['POPUP']})).length),'repeated toolbar click handled');
    assert.equal((await entry()).page.run,first.run,'reopening the extension reuses the running download');
    const row = index.locator('#list li').filter({hasText:'case=directinline'});
    await button(row,'元タブを閉じる').click();
    await until(() => src.isClosed(),'original tab closed before the download finished');
    release();
    await phase(row,'saved');
    const saved = await index.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('直接保存');
      const names = [];
      for await (const name of dir.keys()) names.push(name);
      const clip = await (await dir.getFileHandle('clip.mp4')).getFile();
      return {names, data:[...new Uint8Array(await clip.arrayBuffer())]};
    });
    assert.deepEqual(saved.names,['clip.mp4']);
    assert.deepEqual(Buffer.from(saved.data),bytes);
    assert.equal(managerCount(),before,'no individual queue tabs were created');
  } finally { release(); if (!src.isClosed()) await src.close(); await index.close(); }
  console.log('direct file stayed in the source tab, reused its run and automatically saved every byte after closing the source');
}

export async function testListLive({context,base,original,release,lastNative,until,bytes}) {
  const index = await context.newPage(); await index.goto(base+'/manager.html');
  const url = original.url(), row = index.locator('#list li').filter({hasText:'case=listlive'});
  await original.waitForFunction(() => document.title.startsWith('DL中'));
  await phase(row,'fetching');
  assert.equal(await button(row,'中止').count(),1,'the list controls the running job without opening its queue');
  await button(row,'取得を停止').waitFor();
  assert.ok(await button(row,'元タブを閉じる').isDisabled(),'the live player still needs the source');
  await button(row,'中止').click(); await phase(row,'canceled');
  await button(row,'再取得').click(); await phase(row,'fetching');
  release(); await original.waitForFunction(() => document.title.includes('1区間'));
  await button(row,'取得を停止').click(); await phase(row,'ready');
  const other = await context.newPage(); await other.goto(url);
  await index.bringToFront();
  await Promise.all([original.waitForEvent('close'),button(row,'元タブを閉じる').click()]);
  assert.equal(other.isClosed(),false,'the other tab at the exact same URL is not the source');
  await until(async () => !await button(row,'元タブを閉じる').count(),'closed source control removed');
  await button(row,'保存').click(); await phase(row,'saved');
  assert.deepEqual(await lastNative(),bytes);
  assert.equal(await index.evaluate(() => document.hasFocus()),true);
  await other.close(); await index.close();
  console.log('list stopped and retried original-dependent HLS, closed only the original tab, and saved the complete clip');
}

export async function testDirectPermission({context,base,top,worker,startFromToolbar,until,lastNative,managerCount,bytes}) {
  const src = await context.newPage(), index = await context.newPage(), before = managerCount();
  try {
    await index.goto(base+'/manager.html');
    await src.goto(top+'/file-watch?variant=complete&case=directpermission');
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,src.url());
    await worker.evaluate(url => {
      const origin = new URL(url), pattern = origin.protocol+'//'+origin.hostname+'/*';
      const contains = chrome.permissions.contains.bind(chrome.permissions);
      globalThis.restoreDirectGrant = () => {chrome.permissions.contains=contains; delete globalThis.restoreDirectGrant;};
      chrome.permissions.contains = request => request.origins?.includes(pattern) ? Promise.resolve(false) : contains(request);
    },top);
    await startFromToolbar(src,tabId);
    await src.waitForFunction(() => document.title.startsWith('許可待ち'));
    await startFromToolbar(src,tabId);
    const section = () => index.evaluate(() => {
      const popup = chrome.extension.getViews({type:'popup'})[0];
      return Array.from(popup?.document.querySelectorAll('section:not([hidden]) button') || [])
        .find(button=>button.textContent==='許可して取得')?.closest('section').id;
    });
    await until(section,'the permission action in the toolbar popup');
    assert.equal(await section(),'files','permission for a direct file belongs with the video file');
    await index.bringToFront();
    await worker.evaluate(() => restoreDirectGrant());
    const row = index.locator('#list li').filter({hasText:'case=directpermission'});
    await button(row,'許可して取得').click(); await phase(row,'ready');
    await button(row,'保存').click(); await phase(row,'saved');
    assert.deepEqual(await lastNative(),bytes);
    assert.equal(managerCount(),before);
  } finally {
    await worker.evaluate(() => globalThis.restoreDirectGrant?.());
    await index.close(); await src.close();
  }
  console.log('direct-file permission was identified in the toolbar and granting it from the list saved every byte');
}

export async function testListFiles({context,base,top,worker,nextQueue,lastNative,until,allowSave,repair,managerCount,bytes}) {
  const src = await context.newPage(); await src.goto(top+'/file-watch?variant=truncated');
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,src.url());
  const index = await context.newPage(); await index.goto(base+'/manager.html');
  const owner = await openLegacyFile(index,src,tabId,nextQueue);
  await owner.locator('#phase[data-state="failed"]').waitFor();
  const row = index.locator('#list li').filter({hasText:'variant=truncated'});
  await phase(row,'failed');
  assert.equal(await button(row,'再取得').count(),1,'a direct file can be retried from the list');
  assert.match(await row.innerText(),/全体|一部|不完全/,'the error reason is visible here');
  const before = managerCount();
  await owner.close(); repair(); await button(row,'再取得').click();
  try { await row.locator('.phase[data-state="ready"]').waitFor({timeout:10000}); }
  catch (error) { throw new Error('File retry did not reach ready: ' + await row.innerText(), {cause:error}); }
  // The same tab navigates to the same URL again. A stale control must not close its replacement document.
  const oldUrl = src.url(); await button(row,'元タブを閉じる').waitFor();
  await src.reload(); assert.equal(src.url(),oldUrl);
  await until(async () => !await button(row,'元タブを閉じる').count(),'reloaded source is no longer offered for closing');
  await index.bringToFront();
  const stagedExports = await index.evaluate(() => Number(localStorage.getItem('fixture-staged-exports')));
  await allowSave(false);
  try {
    await button(row,'保存').click();
    await row.locator('.row-note').filter({hasText:/キャンセル|保存できません/}).waitFor();
    await phase(row,'ready');
  } finally { await allowSave(true); }
  // Hold the two sides of Chrome's native save so both transitions are observable even with a tiny file.
  await worker.evaluate(() => {
    const download=chrome.downloads.download, search=chrome.downloads.search, cancel=chrome.downloads.cancel;
    let accept, id, writing=true;
    const chosen=new Promise(resolve=>{accept=resolve;});
    chrome.downloads.download=async options=>{await chosen; id=await download.call(chrome.downloads,options); return id;};
    chrome.downloads.search=async query=>{
      const items=await search.call(chrome.downloads,query);
      return writing && id!=null && query.id===id ? items.map(item=>({...item,state:'in_progress'})) : items;
    };
    chrome.downloads.cancel=async target=>{
      if(target===id)writing=false;
      return cancel.call(chrome.downloads,target);
    };
    globalThis.fixturePicker={accept,complete:async()=>id!=null && (await search.call(chrome.downloads,{id}))[0]?.state==='complete',restore:()=>{
      accept(); writing=false; chrome.downloads.download=download; chrome.downloads.search=search; chrome.downloads.cancel=cancel;
    }};
  });
  try {
    await button(row,'保存').click();
    await row.locator('.phase').filter({hasText:'保存先を選択中'}).waitFor();
    assert.equal(await row.locator('.phase').getAttribute('data-group'),'attention');
    await worker.evaluate(()=>fixturePicker.accept());
    await row.locator('.phase[data-group="active"]').filter({hasText:/^保存中$/}).waitFor();
    await until(()=>worker.evaluate(()=>fixturePicker.complete()),'Chrome has already committed the file');
    await button(row,'保存を中止').click();
    const terminal=row.locator('.phase:is([data-state="ready"],[data-state="saved"])');
    await terminal.waitFor();
    assert.equal(await terminal.getAttribute('data-state'),'saved','a late cancel cannot make an already saved file eligible for a duplicate save');
  } finally { await worker.evaluate(()=>{fixturePicker.restore();delete globalThis.fixturePicker;}); }
  assert.deepEqual(await lastNative(),bytes);
  assert.equal(await index.evaluate(() => Number(localStorage.getItem('fixture-staged-exports'))),stagedExports,
    'an already complete MP4 must go to the browser without a second full-size temporary export');
  assert.equal(src.isClosed(),false); assert.equal(managerCount(),before,'retry/save must not recreate the owner tab');
  await src.close(); await index.close();
  console.log('list retried an orphaned direct file, protected a reloaded source, and saved every byte');
}

export async function testListOwner({context,base,top,worker,nextQueue,gate,lastNative,bytes}) {
  let release = gate();
  const src = await context.newPage(); await src.goto(top+'/file-watch?variant=list-held');
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,src.url());
  const first = await context.newPage(); await first.goto(base+'/manager.html');
  const owner = await openLegacyFile(first,src,tabId,nextQueue);
  await first.bringToFront();
  const find = page => page.locator('#list li').filter({hasText:'variant=list-held'});
  const row = find(first);
  await phase(row,'fetching');
  await button(row,'中止').click(); await phase(row,'canceled');
  await button(row,'再取得').click(); await phase(row,'fetching');
  assert.equal(await first.evaluate(() => document.hasFocus()),true);
  release(); await phase(row,'ready');
  first.once('dialog',dialog => dialog.dismiss());
  await button(row,'破棄').click(); await phase(row,'ready');
  first.once('dialog',dialog => dialog.accept());
  await button(row,'破棄').click(); await phase(row,'canceled');
  await owner.close(); release = gate();
  await button(row,'再取得').click(); await phase(row,'fetching');
  const second = await context.newPage(); await second.goto(base+'/manager.html');
  const remote = find(second); await button(remote,'中止').click(); await phase(remote,'canceled');
  await button(row,'再取得').click(); await phase(row,'fetching');
  await first.close();
  await remote.locator('.phase:is([data-state="interrupted"],[data-state="canceled"])').waitFor();
  await button(remote,'再取得').click(); await phase(remote,'fetching');
  release(); await phase(remote,'ready');
  await button(remote,'保存').click(); await phase(remote,'saved');
  assert.deepEqual(await lastNative(),bytes); await src.close(); await second.close();
  console.log('list controlled the active queue and another list, confirmed discard, and recovered when the worker tab closed');
}

export async function testListCapture({context,base,top,worker,nextQueue,readDownload}) {
  const src = await context.newPage();
  await src.goto(top+'/watch?case=listcapture');
  await src.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 96;
    const paint = canvas.getContext('2d'), video = document.createElement('video');
    video.muted = true; document.body.replaceChildren(video);
    let frame = 0;
    const draw = () => { paint.fillStyle = frame++ % 2 ? 'navy' : 'gold'; paint.fillRect(0,0,128,96); };
    draw(); setInterval(draw,50);
    video.srcObject = canvas.captureStream(15); await video.play();
  });
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,src.url());
  const gettingOwner = nextQueue();
  const chooser = await context.newPage(); await chooser.goto(base+'/popup.html?view=capture&tab='+tabId);
  const owner = await gettingOwner; await owner.locator('#phase[data-state="setup"]').waitFor();
  const index = await context.newPage(); await index.goto(base+'/manager.html');
  const row = index.locator('#list li').filter({hasText:'case=listcapture'});
  await row.getByRole('combobox',{name:'録画形式'}).selectOption('webm');
  await button(row,'録画を開始').click(); await phase(row,'recording');
  assert.ok(await button(row,'元タブを閉じる').isDisabled());
  await owner.locator('#status').filter({hasText:'MiB'}).waitFor();
  await button(row,'録画を停止').click(); await phase(row,'ready');
  await button(row,'保存').click(); await phase(row,'saved');
  const {item,content} = await readDownload();
  assert.equal(item.mime,'video/webm'); assert.ok(item.filename.endsWith('.webm'));
  assert.deepEqual(content.subarray(0,4),Buffer.from([0x1a,0x45,0xdf,0xa3]));
  await owner.close(); await src.close(); if (!chooser.isClosed()) await chooser.close(); await index.close();
  console.log('list selected WebM, started and stopped a real silent capture, and saved a WebM file');
}

export async function testProgressUpdates(context,base) {
  const list = await context.newPage(); await list.goto(base+'/manager.html');
  const keys = await list.evaluate(async () => {
    const {pageId,pagePrefix,statusPrefix} = await import('./queue.mjs');
    const {storageSaveText} = await import('./save-folder.mjs');
    const records={}, keys={};
    for (const phase of ['saved','saving']) {
      const sourceUrl='https://example.invalid/progress-test/'+phase, id=await pageId(sourceUrl), run=crypto.randomUUID();
      // This synthetic progress stream belongs to the test tab. It has no offscreen engine to recover.
      records[pagePrefix+id]={id,run,runner:'tab',title:phase,job:{kind:'hls'},incognito:false,sourceUrl,started:Date.now()};
      records[statusPrefix+id]={phase,run,progress:phase==='saving'?0:null}; keys[phase]=id;
      if (phase==='saving') Object.assign(records[statusPrefix+id],{text:storageSaveText,destinationName:'テスト保存先'});
    }
    await chrome.storage.session.set(records); return keys;
  });
  const done=list.locator('li[data-id="'+keys.saved+'"] .phase'), busy=list.locator('li[data-id="'+keys.saving+'"] .phase');
  await done.waitFor(); await busy.waitFor();
  await done.evaluate(el=>{
    window.quietMutations=0;window.quietObserver=new MutationObserver(rows=>{quietMutations+=rows.length;});
    quietObserver.observe(el,{attributes:true,subtree:true,childList:true});
    quietObserver.observe(document.querySelector('#list-filters'),{attributes:true,subtree:true,childList:true});
    quietObserver.observe(document.querySelector('#list-title'),{childList:true});
  });
  for (const progress of [.25,.50,.92]) {
    await list.evaluate(async ({id,progress})=>{
      const key='download-state:'+id,record=(await chrome.storage.session.get(key))[key];
      await chrome.storage.session.set({[key]:{...record,progress}});
    },{id:keys.saving,progress});
    await busy.filter({hasText:Math.round(progress*100)+'%'}).waitFor();
  }
  const note = list.locator('li[data-id="'+keys.saving+'"] .row-note');
  assert.match(await note.innerText(), /動画ファイルをストレージに保存しています。.*テスト保存先/);
  assert.equal(await list.evaluate(()=>{quietObserver.disconnect();return quietMutations;}),0,
    'updating one export must not rewrite an unrelated completed row');
  await list.evaluate(async ids=>chrome.storage.session.remove(Object.values(ids).flatMap(id=>['download-page:'+id,'download-state:'+id])),keys);
  await list.close(); console.log('one active progress meter changed without repainting the completed row');
}

export async function testListFilters(context,base,top,screenshots) {
  const list = await context.newPage();
  await list.goto(base+'/manager.html');
  const groups = {active:['fetching','saving','recording'],queued:['queued','saveQueued'],attention:['ready','permission','setup','method','reader'],
    stopped:['failed','interrupted','canceled'],saved:['saved']};
  const keys = await list.evaluate(async phases => {
    const {pageId,pagePrefix,statusPrefix} = await import('./queue.mjs');
    const records={}, ids={};
    const titles=['海辺の観察記録','週末のライブ配信','録画テスト','朝の散歩','夜の街を歩く','インタビュー','旅行の記録'];
    for (const [i,phase] of [...phases,'private'].entries()) {
      const sourceUrl='https://example.invalid/video/'+String(i+1).padStart(2,'0'), incognito=phase==='private';
      const id=await pageId(sourceUrl,incognito), run=crypto.randomUUID();
      records[pagePrefix+id]={id,run,title:titles[i] || '映像記録 '+(i+1),job:{kind:'hls'},incognito,sourceUrl,started:phase==='saved'?1000:100-i};
      records[statusPrefix+id]={phase:incognito?'saving':phase,run,progress:phase==='fetching'?.42:null};
      ids[phase]=id;
    }
    await chrome.storage.session.set(records); return ids;
  },Object.values(groups).flat());
  const row = phase => list.locator('li[data-id="'+keys[phase]+'"]');
  const filter = group => list.locator('#list-filters button[data-filter="'+group+'"]');
  let shared;
  try {
    await row('fetching').waitFor();
    assert.equal(await filter('all').count(),1,'a persistent list filter must be available');
    assert.equal(await filter('all').locator('span').innerText(),'14');
    assert.equal(await list.locator('#list-count').innerText(),'14件');
    assert.equal(await row('private').count(),0);
    assert.equal(await list.locator('#list > li').first().getAttribute('data-id'),keys.fetching,
      'unfinished videos are visible above a newer saved video');
    if (screenshots) await list.screenshot({path:path.join(screenshots,'filters-wide.png')});
    for (const [group,phases] of Object.entries(groups)) {
      await filter(group).click();
      assert.equal(await filter(group).getAttribute('aria-pressed'),'true');
      assert.equal(await filter(group).locator('span').innerText(),String(phases.length));
      assert.equal(await list.locator('#list-count').innerText(),phases.length+'件 / 全14件');
      assert.deepEqual(await list.locator('#list > li').evaluateAll(rows=>rows.map(r=>r.dataset.id)),phases.map(p=>keys[p]));
    }
    await list.reload();
    await row('saved').waitFor();
    assert.equal(await filter('saved').getAttribute('aria-pressed'),'true','reloading preserves the chosen view');
    await row('saved').locator('.row-detail').focus();
    await list.evaluate(async id=>{
      const key='download-state:'+id,record=(await chrome.storage.session.get(key))[key];
      await chrome.storage.session.set({[key]:{...record,phase:'failed',text:'テスト用の保存失敗'}});
    },keys.saved);
    await list.locator('#empty').filter({hasText:'保存済み'}).waitFor();
    assert.equal(await filter('saved').locator('span').innerText(),'0');
    assert.equal(await filter('stopped').locator('span').innerText(),'4');
    assert.ok(await filter('saved').evaluate(button=>button===document.activeElement));
    await list.emulateMedia({colorScheme:'dark'}); await list.setViewportSize({width:320,height:690});
    await filter('active').focus(); await list.keyboard.press('Enter'); await row('fetching').waitFor();
    assert.ok(await filter('saved').isHidden(),'an empty filter disappears after leaving it');
    assert.ok(await list.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'filters and rows fit a narrow viewport');
    if (screenshots) await list.screenshot({path:path.join(screenshots,'filters-narrow.png')});

    // A job outside the selected filter can still be using the visible job's original document.
    shared=await context.newPage(); await shared.goto(top+'/watch?case=filter-shared');
    await list.evaluate(async ({keys,url})=>{
      const [tab]=await chrome.tabs.query({url}), frame=await chrome.webNavigation.getFrame({tabId:tab.id,frameId:0});
      const edits={};
      for (const phase of ['fetching','saved']) {
        const pageKey='download-page:'+keys[phase], statusKey='download-state:'+keys[phase];
        const record=await chrome.storage.session.get([pageKey,statusKey]), page=record[pageKey];
        edits[pageKey]={...page,sourceUrl:url,job:{...page.job,tabId:tab.id,sourceDoc:frame.documentId}};
        edits[statusKey]={...record[statusKey],phase,readerMode:'original'};
      }
      await chrome.storage.session.set(edits);
    },{keys,url:shared.url()});
    await filter('saved').click();
    const close=row('saved').getByRole('button',{name:'元タブを閉じる'});
    await close.waitFor(); assert.ok(await close.isDisabled());
    await list.evaluate(async id=>{
      const key='download-state:'+id,record=(await chrome.storage.session.get(key))[key];
      await chrome.storage.session.set({[key]:{...record,readerMode:'queue'}});
    },keys.fetching);
    await Promise.all([shared.waitForEvent('close'),close.click()]);
    await filter('all').click();
    await list.evaluate(async ids=>chrome.storage.session.remove(ids.flatMap(id=>['download-page:'+id,'download-state:'+id])),
      Object.values(keys).filter(id=>id!==keys.saved));
    await list.locator('#list-filters').waitFor({state:'hidden'});
    await row('saved').waitFor();
    assert.ok(await row('saved').locator('.row-detail').evaluate(el=>el===document.activeElement),
      'when redundant filters disappear, keyboard focus moves to the remaining video');
    assert.equal(await list.locator('#list-count').innerText(),'1件');
  } finally {
    if (shared && !shared.isClosed()) await shared.close();
    await list.evaluate(async ids=>chrome.storage.session.remove(Object.values(ids).flatMap(id=>['download-page:'+id,'download-state:'+id])),keys);
    await list.close();
  }
  console.log('list filters count each state, follow changes and preserve keyboard focus and selection');
}
