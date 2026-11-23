// CHROME_BIN and PLAYWRIGHT_MODULE select the browser and driver. HLS_KEEP_OUTPUT keeps test exports.
import assert from 'node:assert/strict';
import { serveArchive637, testAutoGap637 } from './automatic-gaps.mjs';
import { testMergeFailure, testMissingAudio } from './merge-failure.mjs';
import { testModuleUpdate } from './module-update.mjs';
import { testDetectionNavigation, testQueueDeparture, testReadyQueueNavigation } from './navigation.mjs';
import { testSavedPlayback } from './mp4-playback.mjs';
import { testUpdateRetry } from './update-retry.mjs';
import { testRetryRecovery } from './retry-recovery.mjs';
import { gapPreferenceKey } from '../../extension/queue.mjs';
import { holdTestExports, testSaveLimit } from './save-limit.mjs';
import { loseFinishedReply, lostReplyCases, serveDirectBody, testDirectBodies, testFinishedReply, testPickerCancel } from './save-boundaries.mjs';
import { seedFolderSetting, testFolderPresets, testLostFolderReply } from './folder-presets.mjs';
import { testCleanupRetry, testQueuedRecovery, testSlowPanel } from './save-recovery.mjs';
import { testDirectInline, testDirectPermission, testListCapture, testListFiles, testListFilters, testListLive, testListOwner, testProgressUpdates } from './list-actions.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const project = fileURLToPath(new URL('../../', import.meta.url));
const baseDirectory = await realpath(process.env.HLS_TEST_DIR || tmpdir());
const scratch = await mkdtemp(path.join(baseDirectory, 'evs-player-'));
const extension = path.join(scratch, 'extension');
const inspector = path.join(scratch, 'tab-inspector');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
await cp(path.join(project, 'extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
// Reading the real favicon of an extension tab requires tabs permission. Only the separate test observer gets it.
await mkdir(inspector);
await writeFile(path.join(inspector,'manifest.json'), JSON.stringify({manifest_version:3,name:'Local tab inspector',
  version:'1.0',permissions:['tabs','downloads'],background:{service_worker:'inspect.js'}}));
await writeFile(path.join(inspector,'inspect.js'),'chrome.runtime.onInstalled.addListener(() => {});');
const downloads = path.join(scratch,'downloads');
await mkdir(downloads);
await mkdir(path.join(scratch,'profile','Default'),{recursive:true});
await writeFile(path.join(scratch,'profile','Default','Preferences'),JSON.stringify({download:{default_directory:downloads,prompt_for_download:false},savefile:{default_directory:downloads}}));
const engineHtml = path.join(extension,'engine.html');
await writeFile(engineHtml,(await readFile(engineHtml,'utf8')).replace('<head>', '<head><script src="fixture-engine.js"></script>'));
await writeFile(path.join(extension,'fixture-engine.js'), `const write=FileSystemWritableFileStream.prototype.write;
FileSystemWritableFileStream.prototype.write=async function(bytes) {
  const result=await write.call(this,bytes);
  if(bytes instanceof Uint8Array && bytes.length>=512) {const tail=bytes.subarray(-128);if(tail.every(b=>b===90)) window.partialVideoWritten=true; if(tail.every(b=>b===65)) window.partialAudioWritten=true;}
  return result;
};
const writable=FileSystemFileHandle.prototype.createWritable;
FileSystemFileHandle.prototype.createWritable=function(...args) {
  if(this.name==='export') localStorage.setItem('fixture-staged-exports',String(1+Number(localStorage.getItem('fixture-staged-exports'))));
  if(this.name.endsWith('.mp4') && localStorage.getItem('fixture-fail-next')) {localStorage.removeItem('fixture-fail-next');throw Error('テスト用の書き込み失敗');}return writable.apply(this,args);};
const query=FileSystemDirectoryHandle.prototype.queryPermission;
FileSystemDirectoryHandle.prototype.queryPermission=function(...args) {
  if(this.name==='許可テスト' && localStorage.getItem('fixture-folder-prompt')) return Promise.resolve('prompt');
  return query.apply(this,args);
};
chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m?.destination==='hls-engine' && m.action==='start') window.partialVideoWritten=window.partialAudioWritten=false;
 if(!m?.fixtureEngine)return;
 const frame=document.querySelector('iframe');
 if(m.fixtureEngine==='reload'){
  if(!frame){reply({ok:false});return;}
  window.partialVideoWritten=window.partialAudioWritten=false;
  // The final interruption can dispose the frame instead of loading a replacement document.
  const removed=new MutationObserver(()=>{if(!frame.isConnected)done();});
  function done(){removed.disconnect();frame.removeEventListener('load',done);reply({ok:true});}
  removed.observe(document.body,{childList:true,subtree:true});
  frame.addEventListener('load',done,{once:true});frame.src=frame.src;return true;
 }
 reply({frames:document.querySelectorAll('iframe').length,video:!!window.partialVideoWritten,audio:!!window.partialAudioWritten});});\n(${holdTestExports.toString()})();\n(${loseFinishedReply.toString()})();`);
const source = {};
for (const kind of ['video', 'audio']) {
  const file = await readFile(path.join(project, 'tests', 'fixtures', kind + '-fragments.mp4'));
  let pos = 0;
  while (file.toString('ascii', pos + 4, pos + 8) !== 'moof') pos += file.readUInt32BE(pos);
  source[kind] = { init: file.subarray(0, pos), media: file.subarray(pos) };
}
const fragments = [];
for (let pos = 0; source.video.media.toString('ascii', pos + 4, pos + 8) === 'moof';) {
  const mdat = pos + source.video.media.readUInt32BE(pos);
  const end = mdat + source.video.media.readUInt32BE(mdat);
  fragments.push(source.video.media.subarray(pos, end)); pos = end;
}
assert.equal(fragments.length, 3);
const muxedFixture = await readFile(path.join(project,'tests','fixtures','muxed-fragments.mp4'));
const shortSound = await readFile(path.join(project,'tests','fixtures','short-muxed-audio.mp4'));
const padding = Buffer.alloc(16384, 90); padding.writeUInt32BE(padding.length); padding.write('free', 4);
fragments[1] = Buffer.concat([fragments[1], padding]);
const midTransfer = new Set(['midclose','remount','sourceclosed','changedpage','spachange','detachedinvalid','publicparts','framechanged','repeatedloss','recovery403','livereconnect']);
const restricted = new Set(['framed','framedlegacy','framedoff','frameddenied','ownerclosed','remount','sourceclosed','changedpage','publicparts','publicframed','spachange','detachedinvalid','topplayer','livestopinline','parallel','cancelpicker','singlelive','listlive']);
const playerDenial = new Set(['denied','frameddenied']);
const qualityModes = new Set(['displayquality','unplayedquality','ambiguousquality']);
const damagedModes = new Set(['gaprerun','gapsetting','gapfolder','gapmanager','gapclockpair','gapmuxed','joinfailauto','joinfailmanual']);

const servers = [], requests = [], releases = new Map(), ended = new Set(), watchLoads = new Map();
let player, cdn, audio, top, rejectPlaylist = false, repairDirectFile = false;
async function serve(host, handler) {
  const server = createServer(handler);
  servers.push(server); server.listen(0, host); await once(server, 'listening');
  return 'http://' + host + ':' + server.address().port;
}
function media(req, res) {
  const [, scenario, kind, leaf] = new URL(req.url, 'http://local.test').pathname.split('/');
  if (!scenario || !kind) { res.writeHead(404).end(); return; }
  const playerOrigin = scenario === 'topplayer' || scenario === 'gapauto637' ? top : player;
  const pageClient = req.headers.origin === playerOrigin;
  const ref = req.headers.referer || '';
  const publicSegment = (scenario === 'publicparts' && leaf?.endsWith('.m4s')) || (scenario === 'detachedinvalid' && leaf === '1.m4s');
  const damaged = damagedModes.has(scenario) || ['updategap','retrygap','retrychoice'].includes(scenario);
  const valid = damaged || qualityModes.has(scenario) || ['manual','updatepair','retrypair','publicframed','savelimit','fragmentcheck','segment403','missingtrack','shortsound'].includes(scenario) || publicSegment || (pageClient && ref === (scenario === 'private' ? '' : playerOrigin + '/'));
  const denied = (playerDenial.has(scenario) && rejectPlaylist) || (scenario === 'recovery403' && ended.has(scenario) && leaf === '1.m4s') ||
    (scenario === 'segment403' && leaf === '2.m4s') || (damaged && leaf === '1.m4s') ||
    (scenario === 'gapauto637' && leaf === 'p8.m4s');
  const status = valid && !denied ? 200 : 403;
  requests.push({ scenario, kind, leaf, pageClient, refMatches: valid, cookie: !!req.headers.cookie, status });
  res.setHeader('Access-Control-Allow-Origin', scenario === 'exact' ? player : '*');
  res.setHeader('Cache-Control', 'no-store');
  if (status !== 200) { res.writeHead(status).end(); return; }
  if (scenario === 'shortsound') {
    if (kind === 'playlist.m3u8') {
      res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'}).end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\npart.m4s\n#EXT-X-ENDLIST\n');
    } else {
      const initEnd = shortSound.indexOf('moof') - 4;
      res.writeHead(200,{'Content-Type':'video/mp4'}).end(
        kind === 'init.mp4' ? shortSound.subarray(0,initEnd) : shortSound.subarray(initEnd));
    }
    return;
  }
  if (scenario === 'detachedinvalid' && !pageClient && leaf === '1.m4s') {
    res.writeHead(200, {'Content-Type':'video/mp4'}).end('incomplete media'); return;
  }
  if (['gapmuxed','updategap','retrygap','retrychoice'].includes(scenario) || scenario.startsWith('joinfail')) {
    if (leaf === 'video.m3u8') {
      const segments = [0,1,2].map(i => '#EXTINF:0.5,\n' + i + '.m4s').join('\n');
      res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'}).end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="init.mp4"\n' + segments + '\n#EXT-X-ENDLIST\n');
      return;
    }
    const range = {'init.mp4':[0,1306],'0.m4s':[1306,2581],'2.m4s':[3135,muxedFixture.length]}[leaf];
    if (range) {
      const bytes = Buffer.from(muxedFixture.subarray(...range));
      if (scenario.startsWith('joinfail') && leaf === '2.m4s') {
        const clock = bytes.lastIndexOf('tfdt') + 8;
        bytes.writeBigUInt64BE(bytes.readBigUInt64BE(clock) - 641n,clock);
      }
      res.writeHead(200,{'Content-Type':'video/mp4'}).end(bytes);
    }
    else res.writeHead(404).end();
    return;
  }
  if (scenario === 'gapauto637') return serveArchive637(res,leaf,source.video.init,fragments[2]);
  if (scenario === 'fragmentcheck' && (leaf === 'init.mp4' || /^[012]\.m4s$/.test(leaf))) {
    const attempt = requests.filter(r => r.scenario === scenario && r.leaf === leaf).length;
    let bytes;
    if (leaf === 'init.mp4') bytes = attempt === 1 ? source.video.init.subarray(0, source.video.init.readUInt32BE(0)) : source.video.init;
    else if (leaf === '0.m4s') {
      bytes = Buffer.from(fragments[0]);
      if (attempt === 1) bytes = bytes.subarray(0,-7);
      else bytes.writeUInt32BE(0, bytes.readUInt32BE(0));
    } else bytes = fragments[Number(leaf[0])];
    res.writeHead(200, {'Content-Type':'video/mp4'}).end(bytes);
    return;
  }
  if (['singlelive','partialicon','listlive'].includes(scenario) && kind === 'playlist.m3u8') {
    const sequence = scenario === 'partialicon' && ended.has(scenario) ? '#EXT-X-MEDIA-SEQUENCE:4\n' : '';
    res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'}).end('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n'+sequence+'#EXT-X-MAP:URI="1080p/init.mp4"\n#EXTINF:0.72,\n1080p/seg.m4s\n'+(ended.has(scenario)?'#EXT-X-ENDLIST\n':''));
  } else if (qualityModes.has(scenario) && kind === 'playlist.m3u8') {
    res.writeHead(200, {'Content-Type':'application/vnd.apple.mpegurl'}).end(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=12000,RESOLUTION=64x64\nlarge/video.m3u8\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=6000,RESOLUTION=32x32\ndisplayed/video.m3u8\n');
  } else if (kind === 'playlist.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Test",DEFAULT=YES,URI="' + audio + '/' + scenario + '/audio/audio.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=10000,RESOLUTION=32x32,AUDIO="a"\n1080p/video.m3u8\n');
  } else if (leaf?.endsWith('.m3u8')) {
    const dated = scenario === 'gapclockpair';
    const segments = (midTransfer.has(scenario) || damagedModes.has(scenario) || scenario === 'fragmentcheck' || scenario === 'segment403') && kind === '1080p'
      ? '#EXTINF:0.28,\n0.m4s\n#EXTINF:0.28,\n1.m4s\n#EXTINF:'+(dated ? '0.04' : '0.16')+',\n2.m4s\n' : '#EXTINF:0.72,\nseg.m4s\n';
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(
      '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="init.mp4"\n' +
      (dated ? '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z\n' : '') + segments +
      (['live','livereconnect','livestopinline'].includes(scenario) && !ended.has(scenario) ? '' : '#EXT-X-ENDLIST\n'));
  } else {
    if (scenario === 'gapclockpair' && kind === 'audio' && leaf === 'seg.m4s') {
      const bytes = Buffer.from(source.audio.media), at = bytes.indexOf('tfdt') + 8;
      bytes.writeBigUInt64BE(bytes.readBigUInt64BE(at) + 8n * 48000n, at);
      res.writeHead(200, {'Content-Type':'audio/mp4'}).end(bytes);
      return;
    }
    if (scenario === 'framechanged' && kind === 'audio' && leaf === 'seg.m4s') {
      const free = Buffer.from(padding); free.fill(65, 8);
      const bytes = Buffer.concat([source.audio.media, free]);
      res.writeHead(200, { 'Content-Type':'audio/mp4', 'Content-Length':bytes.length, 'X-Content-Type-Options':'nosniff' });
      res.write(bytes.subarray(0, 8192));
      releases.get(scenario).then(() => { if (!res.destroyed) res.end(bytes.subarray(8192)); });
      return;
    }
    if (/^[012]\.m4s$/.test(leaf)) {
      const bytes = fragments[Number(leaf[0])];
      res.writeHead(200, { 'Content-Type':'video/mp4', 'Content-Length':bytes.length, 'X-Content-Type-Options':'nosniff' });
      if (leaf === '1.m4s') {
        res.write(bytes.subarray(0, 8192));
        releases.get(scenario).then(() => { if (!res.destroyed) res.end(bytes.subarray(8192)); });
      } else res.end(bytes);
      return;
    }
    const bytes = source[kind === 'audio' && scenario !== 'missingtrack' ? 'audio' : 'video'][leaf === 'init.mp4' ? 'init' : 'media'];
    const send = () => res.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'video/mp4' }).end(bytes);
    if (leaf === 'seg.m4s' && releases.has(scenario) && !midTransfer.has(scenario)) releases.get(scenario).then(send);
    else send();
  }
}
cdn = await serve('127.0.0.1', media); audio = await serve('localhost', media);
player = await serve('localhost', (req, res) => {
  const mode = new URL(req.url, 'http://local.test').searchParams.get('case');
  if (restricted.has(mode)) res.setHeader('Content-Security-Policy', 'frame-ancestors ' + top);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': mode === 'private' ? 'no-referrer' : 'strict-origin' })
    .end('<!doctype html><title>Public test player</title><video muted preload="none"></video>');
});
function watchPage(req, res) {
  const url = new URL(req.url, 'http://local.test'), mode = url.searchParams.get('case');
  if (url.pathname.startsWith('/direct-body/')) return serveDirectBody(res,url.pathname,source.video);
  if (url.pathname.startsWith('/site-icons/')) {
    res.writeHead(200, {'Content-Type':'image/svg+xml'}).end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="hotpink"/><path d="M6 4v8l6-4z" fill="white"/></svg>');
    return;
  }
  if (url.pathname === '/file-watch') {
    const variant = url.searchParams.get('variant');
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' })
      .end('<!doctype html><title>Local file</title><meta property="og:video" content="/clip.mp4' + (variant ? '?variant='+encodeURIComponent(variant) : '') + '">');
    return;
  }
  if (url.pathname === '/clip.mp4') {
    const bytes = Buffer.concat([source.video.init, source.video.media]);
    const variant = url.searchParams.get('variant');
    if (variant === 'list-held' || variant === 'retry-held') {
      res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length});
      res.write(bytes.subarray(0,128));
      releases.get(variant).then(() => { if (!res.destroyed) res.end(bytes.subarray(128)); });
      return;
    }
    if (url.searchParams.has('variant') && !repairDirectFile) {
      const total = bytes.length, complete = url.searchParams.get('variant') === 'complete';
      const body = complete ? bytes : bytes.subarray(0,128);
      res.writeHead(206, {'Content-Type':'video/mp4','Content-Length':body.length,
        'Content-Range':'bytes 0-' + (body.length-1) + '/' + total}).end(body);
      return;
    }
    res.writeHead(200, { 'Content-Type':'video/mp4', 'Content-Length':bytes.length }).end(bytes);
    return;
  }
  if (url.pathname === '/watch') watchLoads.set(mode, (watchLoads.get(mode) || 0) + 1);
  if (mode === 'topplayer') {
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Referrer-Policy':'strict-origin' }).end('<!doctype html><title>Local top player</title><video preload="none"></video>');
    return;
  }
  if (mode === 'framedlegacy') res.setHeader('Content-Security-Policy', "img-src 'self'");
  const siteIcons = '<link rel="icon" sizes="16x16" href="/site-icons/small.svg"><link id="site-icon" rel="shortcut icon" sizes="any" media="screen" href="/site-icons/player.svg">';
  const title = mode === 'repeatname' ? '保存済み · 制作者の動画' : ['latefolder','nativefilename','observedfilename'].includes(mode) ? '動画テスト 日本語' : 'Local player test';
  res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' })
    .end('<!doctype html><title>' + title + '</title>' + siteIcons + '<iframe src="' + player + '/embed?case=' + encodeURIComponent(mode) + '"></iframe>');
}
top = await serve('127.0.0.1', watchPage);
let context;
try {
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.CHROME_BIN, headless: true, acceptDownloads:false, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-automation', '--mute-audio', '--disable-audio-output', '--disable-background-networking',
      '--autoplay-policy=user-gesture-required', '--disable-extensions-except=' + [extension,inspector].join(','),
      '--load-extension=' + [extension,inspector].join(',')]
  });
  const session = await context.newCDPSession(context.pages()[0]);
  assert.ok((await session.send('Browser.getBrowserCommandLine')).arguments.includes('--mute-audio'));
  await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  const getWorker = suffix => context.serviceWorkers().find(w => w.url().endsWith(suffix)) ||
    context.waitForEvent('serviceworker',{predicate:w => w.url().endsWith(suffix)});
  let [worker, tabInspector] = await Promise.all([getWorker('/background.mjs'),getWorker('/inspect.js')]);
  const base = 'chrome-extension://' + new URL(worker.url()).host;
  async function panelView(tabId, action = '', synthetic = false) {
    const [view] = await worker.evaluate(async ({tabId, action, synthetic}) => chrome.scripting.executeScript({
      target: {tabId}, args: [action, synthetic], func: (action, synthetic) => {
        const host = document.querySelector('[data-embedded-video-download]');
        if (!host) return null;
        const root = chrome.dom.openOrClosedShadowRoot(host);
        const panel = root.querySelector('section'), rect = panel.getBoundingClientRect(), style = getComputedStyle(panel);
        const btn = [...root.querySelectorAll('button')].find(b => b.textContent === action && !b.hidden);
        const bounds = btn?.getBoundingClientRect();
        const point = bounds && {x:bounds.x+bounds.width/2, y:bounds.y+bounds.height/2};
        if (synthetic) btn?.click();
        return { label:root.querySelector('strong').textContent, hint:root.querySelector('p').textContent,
          panel:{top:rect.top, left:rect.left, right:document.documentElement.clientWidth-rect.right,
            surface:style.backgroundColor, ink:style.color},
          buttons:[...root.querySelectorAll('button')].filter(b=>!b.hidden).map(b=>b.textContent), title:document.title,
          point:point && root.elementFromPoint(point.x,point.y) === btn ? point : null };
      }
    }), {tabId, action, synthetic});
    return view?.result;
  }
  function checkPanel(panel) {
    assert.ok(panel.top >= 0 && panel.top <= 24 && panel.right >= 0 && panel.right <= 24 && panel.left >= 0,
      'the entire panel is anchored in the top right of the viewport');
    const luminance = rgb => {
      const [r,g,b] = rgb.match(/\d+/g).slice(0,3).map(v => Number(v)/255)
        .map(v => v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4);
      return 0.2126*r + 0.7152*g + 0.0722*b;
    };
    const light = luminance(panel.surface);
    assert.ok(light > 0.75 && (light+0.05)/(luminance(panel.ink)+0.05) >= 4.5, 'light panel with legible text');
  }
  async function until(check, description, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Timed out waiting for '+description);
  }
  const tabColors = {active:'#1767bf', writing:'#783db9', waiting:'#ffc04b', error:'#be3342', ready:'#13834d', saved:'#52627a'};
  async function expectTabIcon(tabId, expected) {
    let url;
    try { await until(async () => {
      url = await tabInspector.evaluate(async id => (await chrome.tabs.get(id)).favIconUrl, tabId);
      return tabColors[expected] ? url?.startsWith('data:image/svg+xml,') &&
        decodeURIComponent(url).includes('fill="' + tabColors[expected] + '"') : url === expected;
    }, 'Chrome tab ' + tabId + ' icon ' + expected); }
    catch (error) { throw new Error(error.message + ', reported ' + (url || '(none)'), {cause:error}); }
  }
  let createdManagers = 0;
  const isQueue = page => page.url().startsWith(base + '/manager.html?q=');
  context.on('page', page => {
    const count = () => {
      if (!isQueue(page)) return;
      page.off('framenavigated', count);
      createdManagers++;
    };
    page.on('framenavigated', count);
    count();
  });
  async function nextQueue(previous = new Set(context.pages())) {
    let queue;
    await until(() => (queue = context.pages().find(page => !previous.has(page) && isQueue(page))), 'new queue tab');
    return queue;
  }
  async function startFromToolbar(original, tabId) {
    await until(() => worker.evaluate(async () => !(await chrome.runtime.getContexts({contextTypes:['POPUP']})).length),'previous toolbar popup to close');
    await original.bringToFront();
    await worker.evaluate(async id => {
      const tab = await chrome.tabs.update(id, { active:true });
      await chrome.windows.update(tab.windowId, { focused:true });
    }, tabId);
    await until(() => worker.evaluate(async () => {
      try { await chrome.action.openPopup(); return true; } catch { return false; }
    }),'toolbar popup to open',3000);
  }
  async function clickPanel(original, tabId, action) {
    await until(() => worker.evaluate(async () => !(await chrome.runtime.getContexts({contextTypes:['POPUP']})).length),
      'toolbar popup to close before clicking ' + action);
    await original.bringToFront();
    await original.waitForFunction(() => document.hasFocus());
    let point;
    await until(async () => {
      const next = (await panelView(tabId,action))?.point;
      const still = next && next.x === point?.x && next.y === point?.y;
      point = next;
      return still;
    }, 'stable position for ' + action);
    await original.mouse.click(point.x,point.y);
  }
  async function openViewer(original, tabId) {
    const previous = new Set(context.pages());
    await clickPanel(original,tabId,'キューを開く');
    try { return await nextQueue(previous); }
    catch (error) {
      const view = await panelView(tabId,'キューを開く');
      throw new Error(error.message + ' after clicking in ' + new URL(original.url()).searchParams.get('case') +
        ' (' + (view?.label || 'panel closed') + ', ' + (view?.hint || '') + ')',{cause:error});
    }
  }
  async function useChromeFilename(enabled) {
    if (enabled) {
      // CDP's "allow" names downloads by blob URL. Let Chrome select the filename, suppressing just the OS dialog.
      await session.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});
      await worker.evaluate(() => {
        globalThis.actualDownload = chrome.downloads.download.bind(chrome.downloads);
        chrome.downloads.download = options => {
          if (options.saveAs !== true) throw Error('Expected user-initiated Save As');
          return actualDownload({...options,saveAs:false});
        };
      });
    } else {
      await worker.evaluate(() => { chrome.downloads.download = actualDownload; });
      await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
    }
  }
  async function lastNative(expectedName) {
    const last = await worker.evaluate(async () => (await chrome.downloads.search({orderBy:['-startTime'],limit:1}))[0]);
    assert.equal(last.state,'complete');
    assert.equal(path.dirname(last.filename).toLowerCase(),downloads.toLowerCase());
    assert.equal(last.mime,'video/mp4','Chrome should identify the exported video format: ' + path.basename(last.filename));
    assert.equal(path.extname(last.filename),'.mp4','Chrome should suggest a video filename');
    if (expectedName) assert.equal(path.basename(last.filename),expectedName);
    return readFile(last.filename);
  }
  await worker.evaluate(() => chrome.storage.local.set({ streamDetection: true }));
  await context.addInitScript(holdTestExports);
  await context.addInitScript(() => {
    if (location.protocol === 'chrome-extension:') {
      const native = localStorage.getItem('fixture-native-permission');
      if (native && location.pathname === '/manager.html') {
        const contains = chrome.permissions.contains.bind(chrome.permissions);
        chrome.permissions.contains = p => p.permissions?.includes('nativeMessaging')
          ? Promise.resolve(localStorage.getItem('fixture-native-permission') === 'granted') : contains(p);
        chrome.permissions.request = async () => {
          assertClick();
          localStorage.setItem('fixture-native-permission','granted');
          return true;
        };
        if (native === 'granted') chrome.runtime.sendNativeMessage = async () => ({type:'error',text:'テスト用PCツールに接続済み'});
      }
      const query = FileSystemDirectoryHandle.prototype.queryPermission;
      FileSystemDirectoryHandle.prototype.queryPermission = function(...args) {
        if (this.name === '許可テスト' && localStorage.getItem('fixture-folder-prompt')) return Promise.resolve('prompt');
        return query.apply(this,args);
      };
      const originalWrite = FileSystemWritableFileStream.prototype.write;
      FileSystemWritableFileStream.prototype.write = async function(data) {
        const result = await originalWrite.call(this, data);
        if (data instanceof Uint8Array && data.length >= 512) {
          const tail = data.subarray(-128);
          if (tail.every(value => value === 90)) window.partialVideoWritten = true;
          if (tail.every(value => value === 65)) window.partialAudioWritten = true;
        }
        return result;
      };
    }
    if (location.protocol === 'chrome-extension:') window.showSaveFilePicker = async ({suggestedName}) => {
      assertClick();
      const name = suggestedName?.startsWith('parallel-export-') ? suggestedName : 'test-export.mp4';
      if (name.startsWith('parallel-export-')) await navigator.locks.request('fixture-picker/'+name,() => {});
      return (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
    };
    if (location.protocol === 'chrome-extension:') window.showDirectoryPicker = async options => {
      assertClick();
      if (options.mode !== 'readwrite') throw Error('Directory needs write access');
      if (sessionStorage.getItem('fixture-cancel-folder')) throw new DOMException('Picker canceled','AbortError');
      let folder = await navigator.storage.getDirectory();
      for (const name of (sessionStorage.getItem('fixture-folder') || 'テスト保存先').split('/')) {
        folder = await folder.getDirectoryHandle(name, {create:true});
      }
      return folder;
    };
    function assertClick() { if (!navigator.userActivation.isActive) throw Error('Missing save click'); }
  });
  const downloadCount = () => worker.evaluate(async () => (await chrome.downloads.search({})).length);
  const cases = process.env.HLS_TEST_CASES?.split(',') || ['playback','moduleupdate','updateretry','retryengine','retrychoice','retrysavehandoff','retryadmission','retrycancelsave','listprogress','listfilters','directinline','directpermission','slowpanel','cleanupretry','queuerecovery','fragmentcheck','segment403','gapauto637','missingtrack','shortsound',...qualityModes,...damagedModes,'listlive','listfiles','listowner','listnative','listcapture','savelimit','wildcard','exact','private','framed','framedlegacy','parallel','latefolder','repeatname','nativefilename','observedfilename','cancelpicker','singlelive','partialicon','framedoff','topplayer','livestopinline','off','denied','frameddenied','ownerclosed','manual','live','publicframed', ...midTransfer,'preset','fileintegrity','nativefirst','folderpresets',
    'detectroute','queueleave','queueclose','queuereload','readyroute','folderreply',...lostReplyCases,'pickerabort','directbody'];
  for (const mode of cases) {
    if (mode === 'playback') { await testSavedPlayback(context,base); continue; }
    if (mode === 'moduleupdate') { await testModuleUpdate({context,base,cdn,project,extension}); continue; }
    await worker.evaluate(seedFolderSetting);
    if (lostReplyCases.includes(mode)) {
      if (mode === 'folderunsent') await worker.evaluate(seedFolderSetting,{name:'完了通知テスト'});
      await testFinishedReply({mode,context,base,top,worker,until,startFromToolbar,lastNative,bytes:Buffer.concat([source.video.init,source.video.media])}); continue;
    }
    if (mode === 'pickerabort') {
      await testPickerCancel({context,base,top,worker,nextQueue,bytes:Buffer.concat([source.video.init,source.video.media])}); continue;
    }
    if (mode === 'directbody') {
      await worker.evaluate(seedFolderSetting,{name:'内容検査'});
      await testDirectBodies({context,base,top,until,bytes:Buffer.concat([source.video.init,source.video.media])}); continue;
    }
    if (mode === 'folderreply') { await testLostFolderReply({context,base}); continue; }
    if (mode === 'readyroute') {
      await testReadyQueueNavigation({context,base,top,worker,nextQueue,until,lastNative,bytes:Buffer.concat([source.video.init,source.video.media])}); continue;
    }
    if (['retryengine','retrychoice','retrysavehandoff','retryadmission','retrycancelsave'].includes(mode)) {
      await worker.evaluate(seedFolderSetting,{name:'再取得検証'});
      await testRetryRecovery({mode,context,base,top,cdn,extension,worker,requests,releases,until});
      worker = await getWorker('/background.mjs');
      continue;
    }
    if (mode === 'updateretry') {
      await worker.evaluate(seedFolderSetting,{name:'更新再取得'});
      await testUpdateRetry({context,base,top,cdn,extension,worker,requests,releases,until,startFromToolbar,panelView,
        managerCount:() => createdManagers});
      worker = await getWorker('/background.mjs');
      continue;
    }
    // A few cases exercise the user's explicit stop-on-error choice and its retry UI.
    await worker.evaluate(({key, stop}) => stop ? chrome.storage.local.set({[key]:false}) : chrome.storage.local.remove(key),
      {key:gapPreferenceKey(false), stop:['segment403','recovery403'].includes(mode)});
    if (mode === 'gapauto637') {
      await worker.evaluate(seedFolderSetting,{name:'自動スキップ'});
      await worker.evaluate(() => chrome.storage.local.set({'hls-skip-gaps:normal':false}));
      try {
        await testAutoGap637({context,worker,top,cdn,base,startFromToolbar,requests,managerCount:() => createdManagers});
      } finally { await worker.evaluate(() => chrome.storage.local.remove('hls-skip-gaps:normal')); }
      continue;
    }
    if (mode === 'folderpresets') {
      await testFolderPresets({context,base,top,worker,bytes:Buffer.concat([source.video.init,source.video.media]),
        screenshots:process.env.HLS_KEEP_OUTPUT ? scratch : null});
      continue;
    }
    if (mode === 'joinfailauto' || mode === 'joinfailmanual') {
      await testMergeFailure({mode,context,worker,base,top,cdn,nextQueue,startFromToolbar,panelView,expectTabIcon,until});
      continue;
    }
    if (mode === 'missingtrack' || mode === 'shortsound') { await testMissingAudio({mode,context,base,cdn,nextQueue}); continue; }
    if (mode === 'listprogress') { await testProgressUpdates(context,base); continue; }
    if (mode === 'listfilters') { await testListFilters(context,base,top,process.env.HLS_KEEP_OUTPUT ? scratch : null); continue; }
    if (mode === 'directpermission') {
      await testDirectPermission({context,base,top,worker,startFromToolbar,until,lastNative,managerCount:()=>createdManagers,
        bytes:Buffer.concat([source.video.init,source.video.media])});
      continue;
    }
    if (mode === 'directinline') {
      await worker.evaluate(seedFolderSetting,{name:'直接保存'});
      let release;
      releases.set('list-held',new Promise(resolve=>{release=resolve;}));
      await testDirectInline({context,base,top,worker,startFromToolbar,panelView,until,release,managerCount:()=>createdManagers,
        bytes:Buffer.concat([source.video.init,source.video.media])});
      continue;
    }
    rejectPlaylist = false;
    await worker.evaluate(enabled => chrome.storage.local.set({ streamDetection: enabled }), !['off','framedoff'].includes(mode));
    if (mode === 'detectroute') {
      await testDetectionNavigation({context,base,top,cdn,worker,until}); continue;
    }
    if (['queueleave','queueclose','queuereload'].includes(mode)) {
      let release;
      releases.set('list-held',new Promise(resolve => {release=resolve;}));
      await testQueueDeparture({mode,context,base,top,worker,nextQueue,until,release}); continue;
    }
    if (mode === 'framedlegacy') await worker.evaluate(site => chrome.storage.local.set({ ['hls-work-tab:' + site]:true }), top);
    if (mode === 'savelimit') {
      await testSaveLimit({context,base,top,cdn,nextQueue,startFromToolbar,expectTabIcon,until,bytes:Buffer.concat([source.video.init,source.video.media])}); continue;
    }
    if (qualityModes.has(mode)) {
      const original = await context.newPage(), before = createdManagers;
      try {
        await original.goto(top + '/watch?case=' + mode);
        const frame = original.frames().find(f => f.url().startsWith(player + '/'));
        const size = await frame.evaluate(async ({baseUrl, mode}) => {
          const read = async name => (await fetch(new URL(name, baseUrl))).arrayBuffer();
          await read('playlist.m3u8');
          await read('displayed/video.m3u8');
          const video = document.querySelector('video');
          if (mode === 'unplayedquality') return [video.videoWidth, video.videoHeight];
          if (mode === 'ambiguousquality') document.body.append(document.createElement('video'));
          video.preload = 'auto';
          video.muted = true;
          const bytes = new Blob([await read('displayed/init.mp4'), await read('displayed/seg.m4s')], {type:'video/mp4'});
          const ready = new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
          video.src = URL.createObjectURL(bytes);
          await ready;
          return [video.videoWidth, video.videoHeight];
        }, {baseUrl:cdn + '/' + mode + '/', mode});
        assert.deepEqual(size, mode === 'unplayedquality' ? [0,0] : [32,32]);
        const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, original.url());
        const start = requests.length;
        await startFromToolbar(original, tabId);
        await original.waitForFunction(() => document.title.startsWith('保存待ち'));
        const reads = requests.slice(start).filter(r => r.scenario === mode && r.leaf === 'seg.m4s');
        assert.deepEqual(reads.map(r => r.kind), [mode === 'displayquality' ? 'displayed' : 'large']);
        await clickPanel(original, tabId, '保存');
        await original.waitForFunction(() => document.title.startsWith('保存済み'));
        assert.deepEqual(await lastNative(), Buffer.concat([source.video.init,source.video.media]));
        assert.equal(createdManagers,before);
        console.log(mode, 'saved the expected rendition from its own tab');
      } finally { await original.close(); }
      continue;
    }
    if (['gapmanager','gapclockpair','gapmuxed'].includes(mode)) {
      const index = await context.newPage();
      let queue;
      try {
        await index.goto(base+'/manager.html');
        if (mode === 'gapmanager') {
          await index.waitForFunction(() => !document.querySelector('#allow-gaps').disabled);
          await index.locator('#allow-gaps').uncheck();
        }
        const next = nextQueue();
        const path = mode === 'gapclockpair' ? 'playlist.m3u8' : '1080p/video.m3u8';
        await index.evaluate(async job => {
          const {openTransfer} = await import('./jobs.mjs');
          await openTransfer(job);
        },{kind:'hls',label:mode,url:cdn+'/'+mode+'/'+path});
        queue = await next;
        if (mode === 'gapmanager') await queue.locator('#current').getByRole('button',{name:'欠損区間をスキップして再取得'}).click();
        try { await queue.locator('#phase[data-state="ready"]').waitFor(); }
        catch (error) {
          throw new Error('Manual queue after retry: '+await queue.locator('#phase').textContent()+' '+await queue.locator('#status').textContent()+' '+await queue.locator('#notice').textContent(),{cause:error});
        }
        assert.match(await queue.locator('#info').textContent(),/2\/3 区間目/);
        const filename = mode+'（欠損あり）.mp4';
        await queue.evaluate(name => {
          window.showSaveFilePicker = async ({suggestedName}) => {
            if (!navigator.userActivation.isActive || suggestedName !== name) throw Error('Unexpected save');
            return (await navigator.storage.getDirectory()).getFileHandle(suggestedName,{create:true});
          };
        },filename);
        await queue.locator('#save').click();
        await queue.locator('#phase[data-state="saved"]').waitFor();
        assert.match(await queue.locator('#phase').textContent(),/欠損あり/);
        assert.equal(requests.filter(r=>r.scenario===mode && r.leaf==='1.m4s').length,1);
        if (mode !== 'gapmanager') {
          const result = await queue.evaluate(async name => {
            const {Input,MP4,BlobSource,EncodedPacketSink} = await import('./vendor/mediabunny-1.66.2.mjs');
            const file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
            const input = new Input({formats:[MP4],source:new BlobSource(file)});
            try {
              const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
              let samples = 0;
              for await (const packet of new EncodedPacketSink(audio).packets()) samples++;
              return {duration:await input.computeDuration(), video:await video.getFirstTimestamp(), audio:await audio.getFirstTimestamp(), samples};
            } finally { input.dispose(); }
          },filename);
          if (mode === 'gapmuxed') {
            assert.equal(result.samples,49,'the saved MP4 contains all audio frames carried by its retained fragments');
            assert.ok(result.duration >= 1 && result.duration < 1.06, JSON.stringify(result));
          } else assert.ok(result.duration >= .30 && result.duration < .36, JSON.stringify(result));
          assert.ok(Math.abs(result.video-result.audio) < .025, JSON.stringify(result));
        }
        console.log(mode,'saved the marked file from the manual queue');
      } finally { if (queue) await queue.close(); await index.close(); }
      continue;
    }
    if (damagedModes.has(mode)) {
      const original = await context.newPage(), index = await context.newPage();
      let realName = false;
      try {
        if (mode === 'gapfolder') await worker.evaluate(seedFolderSetting,{name:'欠損テスト'});
        await index.goto(base + '/manager.html');
        await index.waitForFunction(() => !document.querySelector('#allow-gaps').disabled);
        const setting = index.getByRole('checkbox',{name:'HLSの欠損区間を自動でスキップ'});
        assert.ok(await setting.isChecked());
        await setting.uncheck();
        if (mode === 'gapsetting') {
          await index.reload();
          await index.waitForFunction(() => !document.querySelector('#allow-gaps').disabled);
          assert.equal(await setting.isChecked(),false);
          assert.ok(await index.evaluate(async () => (await import('./queue.mjs')).readGapPreference(true)));
          await setting.check();
          await index.reload();
          await index.waitForFunction(() => !document.querySelector('#allow-gaps').disabled);
          assert.ok(await setting.isChecked());
        }
        await original.goto(top+'/watch?case='+mode);
        await original.evaluate(async ({uri,title}) => { document.title = title; await (await fetch(uri)).text(); },
          {uri:cdn+'/'+mode+'/1080p/video.m3u8',title:mode});
        const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, original.url());
        await startFromToolbar(original,tabId);
        const row = index.locator('#list li').filter({hasText:mode});
        if (mode !== 'gapsetting') {
          await original.waitForFunction(() => document.title.startsWith('エラー'));
          if (mode === 'gapfolder') await row.getByRole('button',{name:'欠損区間をスキップして再取得'}).click();
          else {
            assert.ok((await panelView(tabId)).buttons.includes('欠損区間をスキップして再取得'));
            await clickPanel(original,tabId,'欠損区間をスキップして再取得');
          }
        }
        if (mode !== 'gapfolder') {
          await original.waitForFunction(() => document.title.includes('保存待ち'));
          await row.locator('.phase[data-state="ready"]').waitFor();
          assert.match(await row.textContent(), /欠損あり/);
          assert.match(await row.textContent(), /2\/3 区間目/);
          await useChromeFilename(true);
          realName = true;
          await clickPanel(original,tabId,'保存');
        }
        await row.locator('.phase[data-state="saved"]').waitFor();
        assert.match(await row.textContent(), /欠損あり/);
        assert.match(await row.textContent(), /2\/3 区間目/);
        const filename = mode+'（欠損あり）.mp4';
        const bytes = mode !== 'gapfolder' ? await lastNative(filename) : Buffer.from(await worker.evaluate(async name => {
          const target = await (await navigator.storage.getDirectory()).getDirectoryHandle('欠損テスト');
          const file = await (await target.getFileHandle(name)).getFile();
          return Array.from(new Uint8Array(await file.arrayBuffer()));
        },filename));
        const {Input,MP4,BlobSource,EncodedPacketSink} = await import('../../extension/vendor/mediabunny-1.66.2.mjs');
        const parse = bytes => new Input({formats:[MP4],source:new BlobSource(new Blob(bytes))});
        const packets = async input => {
          const result = [];
          for await (const packet of new EncodedPacketSink(await input.getPrimaryVideoTrack()).packets()) result.push(packet);
          return result;
        };
        const input = parse([bytes]), beforeGap = parse([source.video.init,fragments[0]]), afterGap = parse([source.video.init,fragments[2]]);
        try {
          const [saved,prefix,suffix] = await Promise.all([input,beforeGap,afterGap].map(packets));
          const expected = [...prefix,...suffix];
          assert.equal(saved.length,expected.length);
          for (const [i,packet] of saved.entries()) {
            assert.deepEqual(packet.data,expected[i].data);
            const time = expected[i].timestamp - prefix[0].timestamp - (i >= prefix.length ? 0.28 : 0);
            assert.ok(Math.abs(packet.timestamp - time) < 0.001);
          }
          assert.ok(await input.computeDuration() < 0.55);
        } finally { for (const reader of [input,beforeGap,afterGap]) reader.dispose(); }
        assert.equal(requests.filter(r=>r.scenario===mode && r.leaf==='1.m4s').length,1);
        assert.ok(requests.some(r=>r.scenario===mode && r.leaf==='2.m4s' && r.status===200));
        console.log(mode,'saved a shorter playable MP4, marked its missing second segment and retained the third');
      } finally {
        if (realName) await useChromeFilename(false);
        await index.close(); await original.close();
      }
      continue;
    }
    if (mode === 'segment403') {
      const original = await context.newPage(), before = createdManagers, downloadsBefore = await downloadCount();
      releases.set(mode, Promise.resolve());
      try {
        await original.goto(top + '/watch?case=segment403');
        await original.evaluate(async url => { await (await fetch(url)).text(); }, cdn + '/segment403/1080p/video.m3u8');
        const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, original.url());
        await until(() => worker.evaluate(async id => (await chrome.action.getBadgeText({tabId:id})) === 'HLS',tabId),'archive playlist detected');
        await startFromToolbar(original,tabId);
        await original.waitForFunction(() => document.title.startsWith('エラー'));
        const panel = await panelView(tabId);
        assert.match(panel.hint,/動画区間.*403・プレーヤー経由.*3\/3 区間目（再生位置 0:00 付近）/);
        assert.equal(panel.panel.surface,'rgb(255, 240, 240)','a stopped download has its own error background');
        assert.ok(panel.buttons.includes('配信を再検出'));
        assert.deepEqual(requests.filter(r => r.scenario === mode && r.leaf.endsWith('.m4s')).map(r => r.status), [200,200,403]);
        assert.equal(createdManagers,before);
        assert.equal(await downloadCount(),downloadsBefore,'a refused VOD must not be saved as a complete file');
        console.log('source tab reported the refused third VOD segment after two successful ones, with no extra media requests or file');
      } finally { await original.close(); }
      continue;
    }
    if (mode === 'fragmentcheck') {
      const original = await context.newPage();
      await original.goto(top + '/watch?case=fragmentcheck');
      await original.evaluate(async url => { document.title = '分割MP4検証'; await (await fetch(url)).text(); }, cdn + '/fragmentcheck/1080p/video.m3u8');
      const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, original.url());
      await until(() => worker.evaluate(async id => (await chrome.action.getBadgeText({tabId:id})) === 'HLS', tabId), 'fragment playlist detection');
      await startFromToolbar(original, tabId);
      await original.waitForFunction(() => document.title.startsWith('保存待ち'));
      const index = await context.newPage(); await index.goto(base + '/manager.html');
      const row = index.locator('#list li').filter({hasText:'分割MP4検証'});
      await row.getByRole('button', {name:'保存', exact:true}).click();
      await row.locator('.phase[data-state="saved"]').waitFor();
      const bytes = await lastNative();
      assert.deepEqual(bytes, Buffer.concat([source.video.init, ...fragments]));
      if (process.env.HLS_KEEP_OUTPUT) await writeFile(path.join(scratch,'fragmentcheck.mp4'), bytes);
      for (const leaf of ['init.mp4','0.m4s']) assert.equal(requests.filter(r => r.scenario === mode && r.leaf === leaf).length, 2);
      await index.close(); await original.close();
      console.log('retook the truncated initialization and media once, corrected a zero-size mdat, and saved all three fragments intact');
      continue;
    }
    if (mode === 'cleanupretry') {
      await testCleanupRetry({context,base,top,bytes:Buffer.concat([source.video.init,source.video.media])});
      continue;
    }
    if (mode === 'queuerecovery') {
      await testQueuedRecovery({context,base,top,worker,nextQueue,bytes:Buffer.concat([source.video.init,source.video.media])});
      continue;
    }
    if (mode === 'slowpanel') {
      await testSlowPanel({context,base,top,cdn,worker,startFromToolbar,panelView,until,bytes:Buffer.concat([source.video.init,source.video.media])}); continue;
    }
    if (mode === 'listfiles') {
      repairDirectFile = false;
      await testListFiles({context,base,top,worker,nextQueue,lastNative,until,
        allowSave:allow => session.send('Browser.setDownloadBehavior',{behavior:allow ? 'allow' : 'deny',downloadPath:downloads}),
        repair:() => { repairDirectFile = true; },managerCount:() => createdManagers,bytes:Buffer.concat([source.video.init,source.video.media])});
      continue;
    }
    if (mode === 'listcapture') {
      await testListCapture({context,base,top,worker,nextQueue,readDownload:async () => {
        const [item] = await worker.evaluate(() => chrome.downloads.search({orderBy:['-startTime'],limit:1}));
        assert.equal(item.state,'complete'); assert.equal(path.dirname(item.filename).toLowerCase(),downloads.toLowerCase());
        return {item,content:await readFile(item.filename)};
      }});
      continue;
    }
    if (mode === 'listowner') {
      const gate = () => {
        let release;
        releases.set('list-held',new Promise(resolve => { release=resolve; }));
        return release;
      };
      await testListOwner({context,base,top,worker,nextQueue,gate,lastNative,bytes:Buffer.concat([source.video.init,source.video.media])});
      continue;
    }
    if (mode === 'nativefirst' || mode === 'listnative') {
      const settings = await context.newPage(); await settings.goto(base+'/manager.html');
      const next = nextQueue();
      await settings.evaluate(async sourceUrl => {
        localStorage.setItem('fixture-native-permission','prompt');
        const {openTransfer} = await import('./jobs.mjs');
        await openTransfer({kind:'whole',provider:'youtube',id:'YE7VzlLtp-4',label:'初回許可検査',sourceUrl});
      },top+'/native-first');
      const queue = await next;
      await queue.locator('#grant').waitFor();
      const before = await queue.evaluate(() => performance.timeOrigin);
      if (mode === 'listnative') {
        await settings.reload();
        await settings.locator('#list li').filter({hasText:'初回許可検査'}).getByRole('button',{name:'許可して取得'}).click();
      } else await queue.locator('#grant').click();
      // The fixture host replies with a distinctive status on its first handshake.
      await queue.locator('#status').filter({hasText:'テスト用PCツールに接続済み'}).waitFor();
      assert.notEqual(await queue.evaluate(() => performance.timeOrigin),before);
      await settings.evaluate(() => localStorage.removeItem('fixture-native-permission'));
      await queue.close(); await settings.close();
      console.log('first native permission reloaded the same queue and contacted the helper'); continue;
    }
    if (mode === 'fileintegrity') {
      for (const variant of ['truncated','complete']) {
        repairDirectFile = false;
        const sourcePage = await context.newPage(); await sourcePage.goto(top+'/file-watch?variant='+variant);
        const id = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,sourcePage.url());
        await startFromToolbar(sourcePage,id);
        const queue = await openViewer(sourcePage,id);
        await queue.waitForFunction(() => ['failed','ready'].includes(document.querySelector('#phase')?.dataset.state));
        if (variant === 'truncated') {
          assert.equal(await queue.locator('#phase').getAttribute('data-state'),'failed','a prefix of the file cannot be offered as complete');
          assert.match(await queue.locator('#status').innerText(),/全体|一部|不完全/);
          repairDirectFile = true;
          await queue.locator('#retry').click();
        }
        await queue.locator('#phase[data-state="ready"]').waitFor();
        await queue.locator('#save').click();
        await queue.locator('#phase[data-state="saved"]').waitFor();
        assert.deepEqual(await lastNative(),Buffer.concat([source.video.init,source.video.media]));
        await queue.close(); await sourcePage.close();
      }
      console.log('fileintegrity rejected an incomplete HTTP 206; retry and a complete HTTP 206 saved all bytes'); continue;
    }
    const original = await context.newPage(), url = top + '/watch?case=' + mode;
    await original.goto(url);
    const frame = mode === 'topplayer' ? original.mainFrame() : original.frames().find(f => f.url().startsWith(player + '/'));
    const urls = [cdn + '/' + mode + '/playlist.m3u8', cdn + '/' + mode + '/1080p/video.m3u8'];
    const initialReads = mode === 'manual' ? [] : ['singlelive','partialicon','listlive'].includes(mode) ? [urls[0]] : urls;
    await frame.evaluate(() => { document.querySelector('video').muted = false; });
    assert.deepEqual(await frame.evaluate(async links => {
      const status = []; for (const link of links) { const r = await fetch(link, {credentials:'omit'}); await r.text(); status.push(r.status); }
      return {status, paused: document.querySelector('video').paused};
    }, initialReads), {status: initialReads.map(() => 200), paused:true});
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, url);
    if (mode === 'framed' || mode === 'framedlegacy') {
      await expectTabIcon(tabId,top+'/site-icons/player.svg');
      await worker.evaluate(id => chrome.tabs.update(id,{pinned:true}),tabId);
    }
    let release;
    releases.set(mode, new Promise(resolve => { release = resolve; }));
    let chooser, prefs, n;
    const before = createdManagers;
    const downloadsBefore = await downloadCount();
    if (mode === 'preset' || mode === 'framedlegacy' || mode === 'repeatname') {
      prefs = await context.newPage(); await prefs.goto(base + '/manager.html');
      if (mode === 'repeatname') await prefs.evaluate(() => sessionStorage.setItem('fixture-folder','名前のテスト保存先'));
      await prefs.getByRole('button', { name:'保存先を指定', exact:true }).click();
      const folderLabel = prefs.locator('#folder-name').filter({hasText:'テスト保存先'});
      await folderLabel.waitFor(); await prefs.reload(); await folderLabel.waitFor();
      await startFromToolbar(original, tabId);
    } else if (['framed','framedlegacy','framedoff','topplayer','livestopinline','parallel','latefolder','cancelpicker','singlelive','partialicon','listlive'].includes(mode)) {
      await startFromToolbar(original, tabId);
    } else {
      chooser = await context.newPage();
      await chooser.goto(base + '/popup.html?tab=' + tabId);
      const rows = chooser.locator('#streams li');
      if (mode === 'manual') await chooser.waitForFunction(() => !document.querySelector('#refresh').disabled);
      else await rows.first().waitFor();
      n = await rows.count();
      rejectPlaylist = playerDenial.has(mode);
      if (mode === 'manual') {
        await chooser.locator('#manual-hls summary').click();
        await chooser.locator('#hls-url').fill(urls[0]);
        await chooser.locator('#hls-form button').click();
      } else await rows.filter({ hasText:'playlist.m3u8' }).getByRole('button').click();
    }
    await original.locator('[data-embedded-video-download]').waitFor({timeout:12000});
    assert.equal(createdManagers,before,'no queue created, even transiently, before explicitly opening');
    if (mode === 'listlive') {
      await testListLive({context,base,original,release,lastNative,until,bytes:Buffer.concat([source.video.init,source.video.media])});
      assert.equal(createdManagers,before,'list controls must never create a queue tab');
      continue;
    }
    if (mode === 'repeatname') {
      ended.add(mode); release();
      const files = () => prefs.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('名前のテスト保存先'), names = [];
        for await (const file of dir.values()) if ((await file.getFile()).size>0) names.push(file.name);
        return names.sort();
      });
      await until(async () => (await files()).length === 1 && await original.title() === '保存済み · 保存済み · 制作者の動画','first download saved');
      await startFromToolbar(original,tabId);
      await until(async () => (await files()).length === 2,'second download saved');
      assert.deepEqual(await files(),['保存済み · 制作者の動画 (2).mp4','保存済み · 制作者の動画.mp4']);
      assert.equal(createdManagers,before); assert.equal(await downloadCount(),downloadsBefore);
      await prefs.getByRole('button',{name:'毎回選ぶ'}).click();
      await prefs.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor();
      await original.close(); await prefs.close();
      console.log('repeatname saved twice using the publisher title and the collision suffix'); continue;
    }
    if (mode === 'parallel' || mode === 'latefolder') {
      const second = await context.newPage(); await second.goto(url + '&second=1');
      const frame2 = second.frames().find(f => f.url().startsWith(player+'/'));
      await frame2.evaluate(async links => { for (const link of links) await (await fetch(link,{credentials:'omit'})).text(); }, urls);
      const id2 = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,second.url());
      await startFromToolbar(second,id2);
      await Promise.all([original,second].map(p => p.waitForFunction(() => document.title.startsWith('DL中'))));
      await Promise.all([tabId,id2].map(id => expectTabIcon(id,'active')));
      assert.equal(createdManagers,before);
      const view = await openViewer(original,tabId);
      await view.locator('#phase[data-state="fetching"]').waitFor(); await view.close();
      ended.add(mode); release();
      await Promise.all([original,second].map(p => p.waitForFunction(() => document.title.startsWith('保存待ち'))));
      if (mode === 'latefolder') {
        await Promise.all([original.close(),second.close()]);
        await tabInspector.evaluate(() => {
          globalThis.renameDownload = (_item,suggest) => suggest({filename:'別の拡張.txt'});
          chrome.downloads.onDeterminingFilename.addListener(renameDownload);
        });
        const prefs = await context.newPage(); await prefs.goto(base+'/manager.html');
        await prefs.evaluate(() => {
          sessionStorage.setItem('fixture-folder','許可テスト');
          localStorage.setItem('fixture-folder-prompt','1');
        });
        await prefs.getByRole('button',{name:'保存先を指定',exact:true}).click();
        const rows = prefs.locator('#list li').filter({hasText:'case=latefolder'});
        await until(async () => await rows.count() === 2 && (await rows.allTextContents()).every(t => t.includes('許可')),
          'both existing jobs wait for permission');
        assert.equal(await downloadCount(),downloadsBefore);
        assert.equal(createdManagers,before+1,'folder selection must not open either queue');
        const reads = requests.filter(r => r.scenario === mode).length;
        await prefs.reload();
        await prefs.locator('#folder-name').filter({hasText:'許可テスト'}).waitFor();
        assert.match(await prefs.locator('#folder-name').innerText(), /書き込み許可が必要/);
        await prefs.evaluate(() => {
          const original = FileSystemDirectoryHandle.prototype.requestPermission;
          FileSystemDirectoryHandle.prototype.requestPermission = function(...args) {
            if (this.name === '許可テスト') {
              if (!navigator.userActivation.isActive) throw Error('Expected permission click');
              localStorage.removeItem('fixture-folder-prompt');
            }
            return original.apply(this,args);
          };
        });
        await prefs.getByRole('button',{name:'自動保存を許可'}).click();
        await prefs.locator('#folder-name').filter({hasText:'（自動保存）'}).waitFor();
        await until(async () => (await rows.allTextContents()).every(t => t.includes('保存済み')), 'both pending jobs saved');
        assert.equal(requests.filter(r => r.scenario === mode).length,reads,'no second fetch after permission renewal');
        const sizes = await prefs.evaluate(async () => {
          const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('許可テスト'), result = {};
          for await (const file of dir.values()) result[file.name] = (await file.getFile()).size;
          return result;
        });
        assert.deepEqual(Object.keys(sizes).sort(),['動画テスト 日本語 (2).mp4','動画テスト 日本語.mp4']);
        assert.ok(sizes['動画テスト 日本語.mp4']>1000);
        assert.equal(sizes['動画テスト 日本語.mp4'],sizes['動画テスト 日本語 (2).mp4']);
        assert.equal(await downloadCount(),downloadsBefore,'folder writes must never invoke Save As');
        await prefs.getByRole('button',{name:'毎回選ぶ'}).click();
        await prefs.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor(); await prefs.close();
        await tabInspector.evaluate(() => chrome.downloads.onDeterminingFilename.removeListener(renameDownload));
        console.log('saved two waiting, same-title jobs after closing both sources and renewing the folder grant'); continue;
      }
      await clickPanel(original,tabId,'保存');
      await original.waitForFunction(() => !document.querySelector('[data-embedded-video-download]'));
      assert.equal((await panelView(id2)).label,'保存待ち');
      await Promise.all([expectTabIcon(tabId,'saved'),expectTabIcon(id2,'ready')]);
      const first = await lastNative();
      await clickPanel(second,id2,'保存');
      await second.waitForFunction(() => !document.querySelector('[data-embedded-video-download]'));
      const secondFile = await lastNative();
      const payload = bytes => {
        for (let i=0; i+8<=bytes.length;) {
          const size=bytes.readUInt32BE(i); assert.ok(size>=8 && i+size<=bytes.length);
          if (bytes.toString('ascii',i+4,i+8)==='mdat') return bytes.subarray(i+8,i+size);
          i+=size;
        }
        assert.fail('MP4 has no media data');
      };
      assert.deepEqual(payload(secondFile),payload(first));
      assert.equal(createdManagers,before+1);
      assert.equal(watchLoads.get(mode),2);
      await writeFile(path.join(scratch,mode+'.mp4'),first);
      await second.close(); await original.close(); console.log('parallel jobs kept independent state and exports'); continue;
    }
    if (mode === 'singlelive' || mode === 'partialicon') {
      release();
      await original.waitForFunction(() => document.title.includes('DL中 1区間'));
      if (mode === 'partialicon') {
        ended.add(mode);
        await original.waitForFunction(() => document.title.startsWith('一部取得・保存待ち'));
        await expectTabIcon(tabId,'waiting');
      } else {
        await clickPanel(original,tabId,'取得を停止');
        await original.waitForFunction(() => document.title.startsWith('保存待ち'));
      }
      await clickPanel(original,tabId,'保存');
      await original.waitForFunction(() => !document.querySelector('[data-embedded-video-download]'));
      await writeFile(path.join(scratch,mode+'.mp4'),await lastNative());
      assert.equal(createdManagers,before); await original.close();
      console.log(mode,'saved available live segments from source'); continue;
    }
    if (['framed','framedlegacy','cancelpicker'].includes(mode)) {
      await original.waitForFunction(() => document.title.startsWith('DL中'));
      if (mode === 'framed') {
        await original.setViewportSize({width:320,height:568});
        await original.emulateMedia({colorScheme:'dark'});
        await original.addStyleTag({content:':root{color-scheme:dark;background:#161c20}body{min-height:200vh}'});
        await original.evaluate(() => window.scrollTo(0,document.documentElement.scrollHeight));
      }
      const fetching = await panelView(tabId);
      checkPanel(fetching.panel);
      // Read the displayed text before fast exports remove the panel.
      await worker.evaluate(tabId => chrome.scripting.executeScript({target:{tabId},func:() => {
        const root = chrome.dom.openOrClosedShadowRoot(document.querySelector('[data-embedded-video-download]'));
        const hint = root.querySelector('p'), label = root.querySelector('strong'), seen = [];
        const observer = new MutationObserver(() => seen.push([label.textContent,hint.textContent,getComputedStyle(root.querySelector('section')).backgroundColor]));
        observer.observe(hint,{childList:true});
        globalThis.fixtureSaveLabels = () => { observer.disconnect(); return seen; };
      }}),tabId);
      await expectTabIcon(tabId,mode === 'framedlegacy' ? top+'/site-icons/player.svg' : 'active');
      if (mode === 'framed') await original.evaluate(() => {
        const site = document.querySelector('#site-icon');
        site.href = '/site-icons/updated.svg'; site.media = '(min-width: 1px)';
      });
      const panel = original.locator('[data-embedded-video-download]');
      if (mode === 'framed' && process.env.HLS_KEEP_OUTPUT) await panel.screenshot({path:path.join(scratch,'fetching.png')});
      assert.ok(fetching.buttons.includes('キューを開く'));
      if (mode === 'framedlegacy') {
        await original.evaluate(() => { document.title='新しい動画タイトル'; });
        await original.waitForFunction(() => /^DL中.* · 新しい動画タイトル$/.test(document.title));
      }
      await worker.evaluate(async id => {
        const until=Date.now()+3000;
        while ((await chrome.runtime.getContexts({contextTypes:['POPUP']})).length && Date.now()<until) await new Promise(r=>setTimeout(r,40));
        const t=await chrome.tabs.update(id,{active:true}); await chrome.windows.update(t.windowId,{focused:true});
        await chrome.action.openPopup();
      }, tabId);
      await original.bringToFront(); await original.mouse.click(5,5);
      assert.equal(createdManagers,before,'repeating the toolbar action must not open a viewer');
      release(); ended.add(mode);
      const run = await worker.evaluate(async url => Object.entries(await chrome.storage.session.get(null)).find(([k,v]) => k.startsWith('download-page:') && v.sourceUrl===url)[1].run,url);
      if (!prefs) {
        await original.waitForFunction(() => document.title.startsWith('保存待ち'));
        await until(() => worker.evaluate(async () => !(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length),'idle document to close');
        const buttons = await panelView(tabId,'保存',true);
        checkPanel(buttons.panel);
        await expectTabIcon(tabId,'ready');
        assert.notEqual(buttons.panel.surface,fetching.panel.surface,'ready has its own visible completion colour');
        if (mode === 'framed' && process.env.HLS_KEEP_OUTPUT) await panel.screenshot({path:path.join(scratch,'ready.png')});
        assert.ok(buttons.buttons.includes('保存'));
        assert.match(buttons.hint,/閉じても.*ダウンロード一覧.*保存できます/);
        assert.equal((await panelView(tabId)).label,'保存待ち');
        if (mode === 'cancelpicker') {
          await session.send('Browser.setDownloadBehavior',{behavior:'deny',downloadPath:downloads});
          await clickPanel(original,tabId,'保存');
          await until(async () => {const v=await panelView(tabId);return v?.label==='保存待ち' && /キャンセル|保存できません/.test(v.hint);},'canceled save returns to ready');
          await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
        }
        await clickPanel(original,tabId,'保存');
      }
      await original.waitForFunction(() => !document.querySelector('[data-embedded-video-download]'),null,{timeout:15000});
      const [labels] = await worker.evaluate(tabId => chrome.scripting.executeScript({target:{tabId},func:() => fixtureSaveLabels()}),tabId);
      if (prefs) {
        assert.ok(labels.result.some(([label,hint,surface]) => label.startsWith('保存中') &&
          hint.includes('動画ファイルをストレージに保存しています。') && hint.includes('閉じても保存は続きます') && surface !== fetching.panel.surface));
      } else {
        assert.ok(labels.result.some(([label,hint]) => label.startsWith('保存準備中') && hint.includes('動画ファイルを準備')));
        assert.ok(labels.result.some(([label]) => label === '保存先を選択中'));
      }
      await until(() => worker.evaluate(async run => {
        const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('download-queue-v1');
        try { await dir.getDirectoryHandle(run); return false; } catch(e) {return e.name==='NotFoundError';}
      },run),'temporary files removed after save');
      let bytes;
      if (prefs) {
        bytes = Buffer.from(await prefs.evaluate(async () => {
          const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('テスト保存先');
          for await(const file of dir.values()) if(file.name.endsWith('.mp4')) return Array.from(new Uint8Array(await (await file.getFile()).arrayBuffer()));
        }));
        assert.equal(await original.title(),'保存済み · 新しい動画タイトル');
        assert.equal(await downloadCount(),downloadsBefore,'a preset folder never opens a browser download');
        await prefs.getByRole('button',{name:'毎回選ぶ',exact:true}).click();
        await prefs.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor(); await prefs.close();
      } else bytes=await lastNative();
      await expectTabIcon(tabId,mode === 'framedlegacy' ? top+'/site-icons/player.svg' : 'saved');
      if (mode === 'framed' || mode === 'framedlegacy') {
        if (mode === 'framed') {
          await original.evaluate(() => {
            const next = document.head.cloneNode(true);
            next.querySelector('#site-icon').media = '(min-width: 2px)';
            const disabled = document.createElement('link');
            disabled.rel = 'icon'; disabled.href = '/site-icons/disabled.svg'; disabled.media = 'not all';
            next.append(disabled);
            document.head.replaceWith(next);
          });
          await original.waitForFunction(() => document.querySelector('#site-icon').media === 'not all' &&
            document.head.querySelectorAll('link[href^="data:image/svg+xml,"]').length === 1);
          await expectTabIcon(tabId,'saved');
        } else {
          await original.evaluate(() => {
            const next = document.head.cloneNode(true);
            next.querySelector('title').textContent = '再描画後の動画タイトル';
            document.head.replaceWith(next);
          });
          await original.waitForFunction(() => document.title === '保存済み · 再描画後の動画タイトル', null, {timeout:3000});
        }
        await original.evaluate(clone => {
          if (clone) document.head.replaceWith(document.head.cloneNode(true));
          history.pushState({}, '', '#next');
        }, mode === 'framed');
        try { await expectTabIcon(tabId,top + (mode === 'framed' ? '/site-icons/updated.svg' : '/site-icons/player.svg')); }
        catch (error) {
          const links = await original.locator('head link').evaluateAll(items => items.map(el => el.outerHTML));
          throw new Error('After navigation: ' + await original.title() + ', links: ' + links.join(', '), {cause:error});
        }
        assert.equal(await original.locator('#site-icon').getAttribute('media'),mode === 'framed' ? '(min-width: 2px)' : 'screen');
        if (mode === 'framed') assert.equal(await original.locator('link[href="/site-icons/disabled.svg"]').getAttribute('media'),'not all');
        assert.equal(await original.locator('link[href="/site-icons/small.svg"]').getAttribute('media'),null);
        assert.equal(await original.title(),mode === 'framed' ? 'Local player test' : '再描画後の動画タイトル');
      }
      assert.ok(bytes.length>1000); await writeFile(path.join(scratch,mode+'.mp4'),bytes);
      assert.equal(createdManagers,before,'source Save creates no queue tab');
      assert.equal(watchLoads.get(mode),1); await original.close();
      console.log(mode,'saved MP4 from original with zero manager tabs'); continue;
    }
    const queue = await openViewer(original,tabId);
    const needsOriginal = restricted.has(mode) && mode !== 'publicframed';
    if (!process.env.HLS_KEEP_SOURCE && !midTransfer.has(mode) && !needsOriginal) await original.close();
    const otherWatchTabs = () => worker.evaluate(async ({url,tabId}) => (await chrome.tabs.query({url})).filter(t => t.id !== tabId).length, {url,tabId});
    if (!process.env.HLS_EXPECT_BASELINE && !playerDenial.has(mode)) {
      // A delayed segment keeps the transfer open while we check the active reader and the real tab count.
      await queue.waitForFunction(() => /配信を取得|区間/.test(document.querySelector('#status').textContent) ||
        ['reader','failed','method'].includes(document.querySelector('#phase').dataset.state), null, {timeout:20000});
      const hint = await queue.locator('#info').innerText();
      assert.equal(await queue.locator('#phase').getAttribute('data-state'), 'fetching', 'expected active transfer: '+await queue.locator('#status').innerText());
      if (needsOriginal) {
        assert.match(hint, /元の動画タブを開いたまま/);
        assert.equal(await frame.evaluate(() => {const v=document.querySelector('video'); return v.paused && !v.muted;}), true);
      } else assert.match(hint, /元の動画タブは閉じられます/);
      assert.equal(await otherWatchTabs(), 0, 'no publisher copy in the tab strip');
      assert.equal(watchLoads.get(mode), 1, 'only the original top-level page was loaded');
      assert.equal(await queue.locator('#work-reader, #prefer-work-tab').count(), 0);
      assert.equal(await queue.locator('iframe').count(),0);
      if (mode === 'livestopinline') {
        const queueTab = await queue.evaluate(async () => (await chrome.tabs.getCurrent()).id);
        await expectTabIcon(queueTab,'active');
        // Move only the last confirmed progress time back, then let the real UI timer expire.
        await queue.evaluate(async () => {
          const key = 'download-state:' + new URLSearchParams(location.search).get('q');
          const state = (await chrome.storage.session.get(key))[key];
          if (!Number.isFinite(state.progressAt)) throw Error('Missing last progress time');
          await chrome.storage.session.set({[key]:{...state,progressAt:Date.now()-59_500}});
        });
        await startFromToolbar(original,tabId);
        await Promise.all([tabId,queueTab].map(id => expectTabIcon(id,'waiting')));
        assert.match(await original.title(),/^進捗更新待ち/);
        release(); await original.waitForFunction(() => document.title.includes('DL中 2区間'));
        await Promise.all([tabId,queueTab].map(id => expectTabIcon(id,'active')));
        await clickPanel(original,tabId,'取得を停止'); await queue.locator('#phase[data-state="ready"]').waitFor();
        await Promise.all([tabId,queueTab].map(id => expectTabIcon(id,'ready')));
      }
      if (mode === 'live' || mode === 'livereconnect') assert.match(hint, /ライブ/);
      if (mode === 'ownerclosed') await queue.close();
    }
    if (midTransfer.has(mode)) {
      if (mode === 'midclose' || mode === 'livereconnect') {
        await worker.evaluate(id => chrome.tabs.update(id, { active:true }), tabId);
        assert.equal(await queue.evaluate(async () => (await chrome.tabs.getCurrent()).active), false);
      }
      const partialWrite = () => until(() => queue.evaluate(async mode => {
        const status=await chrome.runtime.sendMessage({fixtureEngine:'status'});
        return status?.video && (mode !== 'framechanged' || status.audio) &&
          (document.querySelector('#progress').value > 0 || (mode === 'livereconnect' && /映像 [1-9]/.test(document.querySelector('#status').textContent)));
      }, mode),'a completed segment and a partial OPFS write');
      await partialWrite();
      if (mode === 'midclose' || mode === 'livereconnect') {
        const shown = await queue.evaluate(() => ({title:document.title, caption:document.querySelector('#title').textContent,
          percent:document.querySelector('#percent').textContent, status:document.querySelector('#status').textContent}));
        const count = [...shown.status.matchAll(/(\d+) 区間/g)].reduce((sum,m) => sum + Number(m[1]), 0);
        const amount = mode === 'midclose' ? shown.percent : count + '区間';
        assert.equal(shown.title, amount + ' 取得中 · ' + shown.caption);
      }
      if (mode === 'recovery403') ended.add(mode);
      if (mode === 'remount') {
        const remounted = original.waitForEvent('framenavigated', {predicate:f => f !== frame && f.url() === frame.url()});
        await original.evaluate(() => { const old = document.querySelector('iframe'); old.replaceWith(old.cloneNode()); });
        const next = await remounted;
        // The replacement player actually loads the same selected playlist.
        assert.equal(await next.evaluate(async url => {const r=await fetch(url,{credentials:'omit'}); await r.text(); return r.status;}, urls[0]), 200);
      } else if (mode === 'spachange') {
        await original.evaluate(() => history.pushState({}, '', '#different-video'));
        await original.waitForFunction(() => !document.querySelector('[data-embedded-video-download]') && document.title === 'Local player test');
      } else if (mode === 'changedpage') {
        await original.goto(top + '/different?case=changedpage');
        const next = original.frames().find(f => f.url().startsWith(player + '/'));
        assert.equal(await next.evaluate(async url => {const r=await fetch(url,{credentials:'omit'}); await r.text(); return r.status;}, urls[0]), 200);
      } else await original.close();
      if (['framechanged','repeatedloss','livereconnect','recovery403'].includes(mode)) {
        const interruptions = mode === 'repeatedloss' ? 3 : 1;
        for (let i = 0; i < interruptions; i++) {
          if (i) await partialWrite();
          assert.ok((await queue.evaluate(() => chrome.runtime.sendMessage({fixtureEngine:'reload'}))).ok);
        }
      }
      console.log(mode, 'interrupted after a completed segment and a partial disk write');
    }
    let presetName;
    if (mode === 'preset') {
      presetName = await queue.evaluate(async () => {
        const {readEntry} = await import('./queue.mjs'), {safeName} = await import('./media.mjs');
        const {page} = await readEntry(new URLSearchParams(location.search).get('q'));
        const name = safeName(page.title,'mp4');
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('テスト保存先');
        const existing = await dir.getFileHandle(name,{create:true}), writer=await existing.createWritable();
        await writer.write('previous'); await writer.close();
        window.showSaveFilePicker = () => { throw Error('Unexpected per-file picker'); };
        localStorage.setItem('fixture-fail-next','1');
        return name;
      });
    }
    if (['sourceclosed','changedpage'].includes(mode)) {
      const nextRead = () => requests.some(r => r.scenario === mode && r.leaf === '2.m4s');
      await until(async () => nextRead() || await queue.locator('#phase').getAttribute('data-state') === 'failed',
        'a refusal after losing the required source stops the job');
      assert.equal(nextRead(), false, 'lost player access must not turn the rest of an archive into skipped segments');
    }
    if (['recovery403','sourceclosed','changedpage'].includes(mode)) await queue.locator('#phase[data-state="failed"]').waitFor();
    ended.add(mode); release();
    if (mode === 'ownerclosed') {
      assert.equal(await worker.evaluate(async id => (await chrome.tabs.get(id)).url, tabId), url);
      assert.equal(await otherWatchTabs(), 0);
      assert.equal(watchLoads.get(mode), 1);
      await original.waitForFunction(() => document.title.startsWith('保存待ち'));
      const reopened = await openViewer(original,tabId);
      await reopened.locator('#phase[data-state="ready"]').waitFor();
      await clickPanel(original,tabId,'キューを開く');
      await until(() => reopened.evaluate(async () => (await chrome.tabs.getCurrent()).active),'existing viewer focused');
      assert.equal(createdManagers,before+2,'a second Open Queue reuses the existing viewer');
      assert.equal(requests.filter(r=>r.scenario===mode && r.leaf==='seg.m4s').length,2,'both tracks downloaded once');
      await reopened.close();
      await clickPanel(original,tabId,'保存');
      await original.waitForFunction(() => !document.querySelector('[data-embedded-video-download]'));
      await writeFile(path.join(scratch,'ownerclosed.mp4'),await lastNative());
      await chooser.close(); await original.close();
      console.log(mode, 'closing/reopening viewer did not interrupt or restart the job');
      continue;
    }
    if (mode === 'repeatedloss') {
      await queue.locator('#phase[data-state="failed"]').waitFor();
      assert.equal(requests.filter(r => r.scenario === mode && r.leaf === '1.m4s').length, 3);
      await queue.locator('#retry').click();
      await queue.locator('#phase[data-state="ready"]').waitFor();
    } else if (mode === 'preset') {
      await queue.waitForFunction(() => document.querySelector('#phase').dataset.state === 'ready' &&
        document.querySelector('#status').textContent.includes('テスト用の書き込み失敗'));
    } else await queue.waitForFunction(() => ['ready','failed'].includes(document.querySelector('#phase')?.dataset.state), {}, {timeout:18000});
    const phase = await queue.locator('#phase').getAttribute('data-state');
    if (mode === 'frameddenied') {
      const queueTab = await queue.evaluate(async () => (await chrome.tabs.getCurrent()).id);
      await Promise.all([tabId,queueTab].map(id => expectTabIcon(id,'error')));
      assert.match(await original.title(),/^エラー · /);
    }
    const summary = await queue.locator('#status').innerText();
    const traffic = requests.filter(r => r.scenario === mode);
    console.log(mode, 'candidates', n ?? 'toolbar', 'queue', phase, summary, 'HTTP', traffic.map(r => r.status).join(','));
    if (!process.env.HLS_EXPECT_BASELINE) {
      assert.ok((await queue.title()).startsWith(phase === 'failed' ? 'エラー · ' : '保存待ち · '));
      assert.equal(watchLoads.get(mode), 1, 'no duplicate publisher page navigation');
      assert.equal(await otherWatchTabs(), 0);
    }
    if (process.env.HLS_EXPECT_BASELINE) {
      assert.equal(n, 2); assert.equal(phase, 'failed'); assert.match(summary,/403/);
    } else if (mode === 'spachange' || mode === 'detachedinvalid') {
      assert.equal(phase,'failed'); assert.match(summary,/403・拡張から直接/);
      assert.equal(traffic.filter(r => r.leaf === '2.m4s' && !r.pageClient && r.status === 403).length, 1);
      if (mode === 'detachedinvalid') {
        assert.ok(traffic.some(r => r.leaf === '1.m4s' && !r.pageClient && r.status === 200));
        assert.match(await queue.locator('#info').innerText(), /元ページ/);
        assert.equal(await queue.locator('#save').isVisible(),false);
      }
    } else if (['recovery403','sourceclosed','changedpage'].includes(mode)) {
      assert.equal(phase, 'failed'); assert.match(summary, mode === 'recovery403' ? /403・プレーヤー経由/ : /403・拡張から直接/);
      assert.match(summary,/2\/3 区間目（再生位置 0:00 付近）/);
      if (mode !== 'recovery403') assert.match(await queue.locator('#info').innerText(), /元ページ/);
      assert.deepEqual(traffic.filter(r => r.leaf === '1.m4s').map(r => r.status), [200,403]);
      assert.equal(traffic.filter(r => r.leaf === '2.m4s').length, 0);
    } else if (!playerDenial.has(mode)) {
      if (chooser) assert.equal(n, mode === 'manual' ? 0 : 1);
      assert.equal(phase, 'ready');
      assert.ok(traffic.every(r => !r.cookie));
      assert.ok(traffic.every(r => r.status === 200));
      if (mode === 'publicframed') assert.ok(traffic.some(r => !r.pageClient));
      else if (mode === 'publicparts') {
        assert.ok(traffic.some(r => !r.pageClient && r.status === 200 && r.leaf === '1.m4s'));
        assert.ok(traffic.filter(r => !r.pageClient && r.status === 200).every(r => r.leaf.endsWith('.m4s')));
      }
      else assert.ok(traffic.filter(r => r.status === 200).every(r => r.pageClient === (mode !== 'manual')));
      if (midTransfer.has(mode)) {
        const hits = leaf => traffic.filter(r => r.leaf === leaf).length;
        assert.equal(hits('0.m4s'), mode === 'repeatedloss' ? 2 : 1, mode+' first completed segment'); assert.equal(hits('2.m4s'), 1, mode+' final segment');
        assert.equal(hits('1.m4s'), mode === 'midclose' ? 1 : mode === 'repeatedloss' ? 4 : 2);
        if (mode === 'framechanged') assert.equal(hits('seg.m4s'), 2);
        const spooled = kind => queue.evaluate(async kind => {
          const { readEntry } = await import('./queue.mjs'), { spool } = await import('./queue-files.mjs');
          const { page } = await readEntry(new URLSearchParams(location.search).get('q'));
          const file = await (await spool(page.run, kind)).getFile();
          return Array.from(new Uint8Array(await file.arrayBuffer()));
        }, kind);
        assert.deepEqual(Buffer.from(await spooled('video')), Buffer.concat([source.video.init, ...fragments]));
        const audioParts = [source.audio.init, source.audio.media];
        if (mode === 'framechanged') {
          const free = Buffer.from(padding); free.fill(65, 8); audioParts.push(free);
        }
        assert.deepEqual(Buffer.from(await spooled('audio')), Buffer.concat(audioParts));
      }
      if (mode === 'preset') {
        await queue.locator('#folder-name').filter({hasText:'テスト保存先'}).waitFor();
        const save = queue.getByRole('button', { name:'保存して閉じる', exact:true });
        await save.waitFor();
        const closed = queue.waitForEvent('close'); await save.click(); await closed;
        const files = await prefs.evaluate(async () => {
          const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('テスト保存先');
          const results = {};
          for await (const file of dir.values()) results[file.name] = Array.from(new Uint8Array(await (await file.getFile()).arrayBuffer()));
          return results;
        });
        const filename = presetName;
        const copy = filename.replace(/\.mp4$/, ' (2).mp4');
        assert.deepEqual(Object.keys(files).sort(), [filename,copy].sort());
        assert.equal(Buffer.from(files[filename]).toString(),'previous');
        assert.ok(files[copy].length > 1000); await writeFile(path.join(scratch,'preset.mp4'),Buffer.from(files[copy]));
        const filePage = await context.newPage(); await filePage.goto(top + '/file-watch');
        const fileTab = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, filePage.url());
        const managersBeforeFile = createdManagers;
        await startFromToolbar(filePage,fileTab);
        await filePage.waitForFunction(() => document.title.startsWith('保存済み'));
        assert.equal(createdManagers,managersBeforeFile,'automatic direct save leaves the user on the source tab');
        await filePage.close();
        assert.equal(await downloadCount(),downloadsBefore,'automatic file and HLS writes use the chosen directory');
        const directBytes = await prefs.evaluate(async () => {
          const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('テスト保存先');
          const clip = await (await folder.getFileHandle('clip.mp4')).getFile();
          return Array.from(new Uint8Array(await clip.arrayBuffer()));
        });
        assert.deepEqual(Buffer.from(directBytes), Buffer.concat([source.video.init, source.video.media]));
        await prefs.getByRole('button', {name:'毎回選ぶ',exact:true}).click();
        await prefs.locator('#folder-name').filter({hasText:'毎回選択'}).waitFor();
        await prefs.reload(); await prefs.locator('#collection').waitFor();
        await prefs.locator('#folder-presets').getByRole('button', {name:'テスト保存先',exact:true}).waitFor();
        await prefs.close();
        console.log('automatic save kept existing files, allowed retry, and also saved a direct video');
        continue;
      }
      const testManualName = mode === 'nativefilename' || mode === 'observedfilename';
      if (mode === 'observedfilename') {
        await tabInspector.evaluate(() => {
          globalThis.observeName = (_item, suggest) => suggest();
          chrome.downloads.onDeterminingFilename.addListener(observeName);
        });
      }
      if (testManualName) await useChromeFilename(true);
      await queue.locator('#save').click();
      await queue.locator('#phase[data-state="saved"]').waitFor();
      assert.ok((await queue.title()).startsWith('保存済み · '));
      const bytes = await lastNative(mode === 'nativefilename' ? '動画テスト 日本語.mp4' : undefined);
      if (mode === 'observedfilename') {
        const [item] = await worker.evaluate(() => chrome.downloads.search({orderBy:['-startTime'],limit:1}));
        assert.equal(item.mime,'video/mp4');
        assert.match(item.filename,/\.mp4$/i);
        await tabInspector.evaluate(() => chrome.downloads.onDeterminingFilename.removeListener(observeName));
      }
      if (testManualName) await useChromeFilename(false);
      await writeFile(path.join(scratch, mode + '.mp4'), Buffer.from(bytes));
    } else {
      assert.equal(phase, 'failed'); assert.match(summary, /403・プレーヤー経由/); assert.equal(traffic.filter(r => r.status === 403).length, 1);
      assert.ok(traffic.every(r => r.pageClient));
      assert.equal(traffic.filter(r => r.leaf === 'seg.m4s').length, 0);
      if (mode === 'frameddenied') {
        const failedPanel = await panelView(tabId);
        assert.ok(failedPanel.buttons.includes('配信を再検出'), 'a source refusal should offer redetection on the original page');
        assert.ok(failedPanel.buttons.includes('再取得'), 'retry is still available for a temporary refusal');
        const requestsBefore = requests.filter(r => r.scenario === mode && r.leaf === 'seg.m4s').length;
        const [recovery] = await Promise.all([context.waitForEvent('page'), clickPanel(original,tabId,'配信を再検出')]);
        await recovery.waitForURL(url => url.protocol === 'chrome-extension:' && url.host === new URL(base).host && url.pathname === '/popup.html' &&
          url.searchParams.get('view') === 'recover' && url.searchParams.get('tab') === String(tabId));
        await recovery.locator('#refresh:not(:disabled)').waitFor();
        assert.equal(await queue.locator('#phase').getAttribute('data-state'),'failed');
        assert.equal(requests.filter(r => r.scenario === mode && r.leaf === 'seg.m4s').length, requestsBefore);
        assert.equal(watchLoads.get(mode),1,'redetection must not reopen the original site');
        await recovery.close();
        rejectPlaylist = false;
        await clickPanel(original,tabId,'再取得');
        await expectTabIcon(tabId,'ready');
        queue.once('dialog', dialog => dialog.accept());
        await queue.locator('#discard').click();
        await expectTabIcon(tabId,'waiting');
        assert.match(await original.title(),/^キャンセル · /);
        await original.reload();
        await expectTabIcon(tabId,top+'/site-icons/player.svg');
      }
    }
    if (!original.isClosed()) await original.close();
    await chooser?.close(); await queue.close();
  }
  console.log('Completed',cases.length,'browser scenarios');
  if (process.env.HLS_KEEP_OUTPUT) console.log('Output directory:', scratch);
} finally {
  await context?.close();
  await Promise.all(servers.map(s => new Promise(done => {s.close(done); s.closeAllConnections();})));
  if (!process.env.HLS_KEEP_OUTPUT) {
    const resolved = await realpath(scratch);
    assert.equal(resolved, scratch);
    assert.equal(path.dirname(resolved), baseDirectory);
    assert.ok(path.basename(resolved).startsWith('evs-player-'));
    await rm(resolved, { recursive: true, force: true });
  }
}
