import assert from 'node:assert/strict';
import { seedFolderSetting } from './folder-presets.mjs';

const panelSelector = '[data-embedded-video-download]';

async function readyPanel(page, name, {context,top,worker,startFromToolbar,panelView,until}) {
  await page.goto(top+'/file-watch?case='+name);
  const loaded = await page.evaluate(() => {
    const icon = document.createElement('link');
    icon.rel = 'icon'; icon.id = 'publisher-icon'; icon.media = 'screen'; icon.href = '/site-icons/player.svg';
    document.head.append(icon);
    return performance.timeOrigin;
  });
  const errors = [];
  const session = await context.newCDPSession(page);
  session.on('Runtime.exceptionThrown', ({exceptionDetails}) => errors.push(exceptionDetails.exception?.description || exceptionDetails.text));
  await session.send('Runtime.enable');
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,page.url());
  await startFromToolbar(page,tabId);
  let view;
  await until(async () => {
    view = await panelView(tabId,'キューを開く');
    return view?.label === '保存待ち' && view.point;
  },'ready source panel');
  await page.waitForFunction(() => document.querySelector('#publisher-icon').media === 'not all');
  return {tabId,loaded,view,errors};
}

async function assertReleased(page, {loaded,errors}, until) {
  await until(async () => errors.length || !(await page.locator(panelSelector).count()),'expired panel to release its controls');
  assert.deepEqual(errors,[],'an expired panel must not raise an uncaught error');
  assert.equal(await page.title(),'Local file');
  assert.equal(await page.locator('#publisher-icon').getAttribute('media'),'screen');
  assert.equal(await page.evaluate(() => performance.timeOrigin),loaded,'keep the video document open');
}

export async function testSourcePanelConnection(fixture) {
  const {context,worker,panelView,until} = fixture;
  const page = await context.newPage();
  try {
    const ready = await readyPanel(page,'panelconnection',fixture);
    const {tabId,view} = ready;
    // A transport failure while the extension is still installed leaves the action available.
    await worker.evaluate(tabId => chrome.scripting.executeScript({target:{tabId},func:() => {
      chrome.runtime.sendMessage = () => Promise.reject(Error('fixture delivery failed'));
    }}),tabId);
    await page.mouse.click(view.point.x,view.point.y);
    await until(async () => (await panelView(tabId))?.hint !== view.hint,'delivery failure to be shown');
    assert.ok((await panelView(tabId,'キューを開く'))?.point);
    // Some Chrome versions remove the runtime binding altogether from an obsolete world.
    await worker.evaluate(tabId => chrome.scripting.executeScript({target:{tabId},func:() => { globalThis.chrome = {}; }}),tabId);
    await page.mouse.click(view.point.x,view.point.y);
    await assertReleased(page,ready,until);
    console.log('the source panel kept controls on a delivery failure and retired them when the runtime disappeared');
  } finally { await page.close(); }
}

export async function testSourcePanelReload(fixture) {
  const {context,base,worker,until,bytes} = fixture;
  const folderName = '更新テスト-'+crypto.randomUUID();
  const clicked = await context.newPage(), untouched = await context.newPage(), management = await context.newPage();
  const probe = await context.newPage();
  try {
    const first = await readyPanel(clicked,'panelreload',fixture);
    const second = await readyPanel(untouched,'panelreattach',fixture);
    const extensionId = new URL(worker.url()).host;
    await management.goto('chrome://extensions/?id='+extensionId);
    await management.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}));
    await management.waitForFunction(async () => (await chrome.developerPrivate.getProfileConfiguration()).inDeveloperMode);
    await clicked.bringToFront();
    const {point} = await fixture.panelView(first.tabId,'キューを開く');
    await worker.evaluate(() => chrome.storage.session.set({fixtureBeforeReload:true}));
    await management.evaluate(id => new Promise((resolve,reject) => chrome.developerPrivate.reload(id,{failQuietly:true},() => {
      const error = chrome.runtime.lastError;
      if (error) reject(Error(error.message)); else resolve();
    })),extensionId);
    await until(async () => {
      try { await probe.goto(base+'/transfer.html'); }
      catch (error) { if (error.message.includes('ERR_BLOCKED_BY_CLIENT')) return false; throw error; }
      return await probe.evaluate(async () => !(await chrome.storage.session.get('fixtureBeforeReload')).fixtureBeforeReload);
    },'the new extension session to accept requests');
    await clicked.mouse.click(point.x,point.y);
    await assertReleased(clicked,first,until);

    // Run a real scan while the other source tab remains in the background.
    await probe.goto(base+'/popup.html?tab='+second.tabId);
    const acquire = probe.locator('#files button');
    await acquire.waitFor();
    await assertReleased(untouched,second,until);
    await probe.evaluate(seedFolderSetting,{name:folderName});
    await acquire.click();
    await untouched.waitForFunction(() => document.title === '保存済み · Local file');
    const saved = await probe.evaluate(async name => {
      const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle(name);
      const names = [];
      for await (const name of dir.keys()) names.push(name);
      const file = await (await dir.getFileHandle('clip.mp4')).getFile();
      return {names,data:[...new Uint8Array(await file.arrayBuffer())]};
    },folderName);
    assert.deepEqual(saved.names,['clip.mp4']);
    assert.deepEqual(Buffer.from(saved.data),bytes);
    assert.deepEqual(second.errors,[]);
    assert.equal(await untouched.evaluate(() => performance.timeOrigin),second.loaded);
    console.log('after a real extension reload both old panels released their title and icon, and the unchanged source tab saved the complete MP4 once');
  } finally { await Promise.all([clicked.close(),untouched.close(),management.close(),probe.close()]); }
}
