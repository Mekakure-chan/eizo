import assert from 'node:assert/strict';
import { openLegacyFile } from './list-actions.mjs';

export async function testDetectionNavigation({context,base,top,cdn,worker,until}) {
  const source = await context.newPage(), probe = await context.newPage();
  try {
    await source.goto(top+'/watch?case=history');
    await probe.goto(base+'/transfer.html');
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,source.url());
    const embedded = source.frames().find(frame => frame.parentFrame());
    const playlist = cdn+'/savelimit/1080p/video.m3u8?track=';
    const request = (frame,track) => frame.evaluate(async url => {
      const response = await fetch(url);
      if (!response.ok) throw Error('Fixture playlist returned '+response.status);
      await response.text();
    },playlist+track);
    const candidates = () => probe.evaluate(async tabId =>
      (await chrome.runtime.sendMessage({op:'detected',tabId})).map(item => item.url).sort(),tabId);
    await request(source,'main');
    await request(embedded,'embed');
    await until(async () => (await candidates()).length === 2,'both playlists');
    await worker.evaluate(tabId => {
      globalThis.routeEvents = 0;
      globalThis.observeFixtureRoute = event => { if (event.tabId === tabId) globalThis.routeEvents++; };
      chrome.webNavigation.onHistoryStateUpdated.addListener(observeFixtureRoute);
      chrome.webNavigation.onReferenceFragmentUpdated.addListener(observeFixtureRoute);
    },tabId);
    async function navigate(frame, action) {
      const before = await worker.evaluate(() => routeEvents);
      await frame.evaluate(action);
      await until(() => worker.evaluate(before => routeEvents > before,before),'Chrome navigation event');
      return candidates();
    }
    const both = [playlist+'embed',playlist+'main'];
    assert.deepEqual(await navigate(source,() => history.replaceState({position:16},'',location.href)),both,
      'updating the player position at the same address must keep both playlists');
    assert.deepEqual(await navigate(embedded,() => history.pushState({playing:true},'',location.href)),both);
    assert.deepEqual(await navigate(embedded,() => history.replaceState(null,'','?episode=2')),[playlist+'main']);
    await probe.goto(base+'/popup.html?tab='+tabId);
    await probe.locator('#status').filter({hasText:'HLSの候補を1件'}).waitFor();
    await request(embedded,'next');
    await until(async () => (await candidates()).length === 2,'replacement player playlist');
    assert.deepEqual(await navigate(source,() => { location.hash = 'another-video'; }),[],
      'a different hash-routed video must start without old candidates');
    assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({tabId:id}),tabId),'');
    await probe.goto(base+'/popup.html?tab='+tabId);
    await probe.locator('#status').filter({hasText:/まだ動画が見つかりません|HLSの候補/}).waitFor();
    assert.equal(await probe.locator('#streams li').count(),0,
      'rescanning must not offer resource timing entries for the previous video');
    await request(embedded,'fresh');
    await until(async () => (await candidates()).length === 1,'a playlist from the new video');
    await probe.locator('#refresh').click();
    await probe.locator('#status').filter({hasText:'HLSの候補を1件'}).waitFor();
    await source.evaluate(url => {
      const current = document.createElement('meta');
      current.setAttribute('property','og:video'); current.content = url;
      document.head.append(current);
    },playlist+'main');
    await probe.locator('#refresh').click();
    await probe.locator('#status').filter({hasText:'HLSの候補を2件'}).waitFor();
    console.log('history updates kept both playlists and actual player or video navigation cleared the matching candidates');
  } finally {
    await worker.evaluate(() => {
      if (!globalThis.observeFixtureRoute) return;
      chrome.webNavigation.onHistoryStateUpdated.removeListener(observeFixtureRoute);
      chrome.webNavigation.onReferenceFragmentUpdated.removeListener(observeFixtureRoute);
      delete globalThis.observeFixtureRoute;
    }).catch(() => {});
    await Promise.all([source.close(),probe.close()]);
  }
}

export async function testQueueDeparture({mode,context,base,top,worker,nextQueue,until,release}) {
  const source = await context.newPage(), probe = await context.newPage();
  let owner, id, run;
  try {
    await source.goto(top+'/file-watch?variant=list-held&case='+mode);
    await probe.goto(base+'/transfer.html');
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,source.url());
    owner = await openLegacyFile(probe,source,tabId,nextQueue);
    await owner.locator('#phase[data-state="fetching"]').waitFor();
    id = new URL(owner.url()).searchParams.get('q');
    const entry = () => probe.evaluate(async id => (await import('./queue.mjs')).readEntry(id),id);
    run = (await entry()).page.run;
    const hasTemporaryFile = () => probe.evaluate(async run => {
      const {spool} = await import('./queue-files.mjs');
      try { await spool(run,'video'); return true; }
      catch (error) { if (error.name === 'NotFoundError') return false; throw error; }
    },run);
    await until(hasTemporaryFile,'file for the held foreground acquisition');
    if (mode === 'queueleave') {
      await owner.goto(base+'/manager.html');
      await owner.locator('#list li[data-id="'+id+'"]').waitFor();
    } else if (mode === 'queuereload') await owner.reload();
    else await owner.close();
    await until(async () => {
      const {page,state} = await entry();
      const ownerMatches = mode === 'queuereload' ? Number.isInteger(page.owner) : page.owner == null;
      return ownerMatches && ['interrupted','canceled'].includes(state.phase);
    },'previous queue to release the tab and stop reporting an active acquisition',4000);
    await until(async () => !await hasTemporaryFile(),'partial download to be deleted after leaving its tab',4000);
    console.log(mode,'released the foreground queue and removed its incomplete bytes');
  } finally {
    release();
    if (owner && !owner.isClosed()) await owner.close();
    if (id && run) await probe.evaluate(async ({id,run}) => {
      await (await import('./queue-files.mjs')).dropFiles(run);
      await chrome.storage.session.remove(['download-page:'+id,'download-state:'+id]);
    },{id,run});
    await Promise.all([probe.close(),source.close()]);
  }
}

export async function testReadyQueueNavigation({context,base,top,worker,nextQueue,until,lastNative,bytes}) {
  const source = await context.newPage(), probe = await context.newPage();
  let owner, id;
  try {
    await source.goto(top+'/file-watch?case=ready-navigation');
    await probe.goto(base+'/transfer.html');
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,source.url());
    owner = await openLegacyFile(probe,source,tabId,nextQueue);
    await owner.locator('#phase[data-state="ready"]').waitFor();
    id = new URL(owner.url()).searchParams.get('q');
    await source.close();
    await owner.goto(base+'/manager.html');
    await until(() => probe.evaluate(async id => {
      const {page,state} = await (await import('./queue.mjs')).readEntry(id);
      return page.owner == null && state.phase === 'ready';
    },id),'ready queue to remain available without a foreground owner');
    const row = owner.locator('#list li[data-id="'+id+'"]');
    await row.getByRole('button',{name:'保存',exact:true}).click();
    await row.locator('.phase[data-state="saved"]').waitFor();
    assert.deepEqual(await lastNative(),bytes);
    console.log('closed the original and saved the complete waiting file from the same tab after navigating to the list');
  } finally {
    if (owner && !owner.isClosed()) await owner.close();
    if (id) await probe.evaluate(id => chrome.storage.session.remove(['download-page:'+id,'download-state:'+id]),id);
    await probe.close();
    if (!source.isClosed()) await source.close();
  }
}
