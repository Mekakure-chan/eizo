import { element, fullPlaylistUrl, hostPattern, httpUrl, providerHints, timeLabel, videosFrom } from './media.mjs';
import { wholeVideo } from './whole.mjs';
import { allSites, detectionSetting, playlistResponse, rememberStream } from './discovery.mjs';
import { openTransfer, readJob, requireOrigins } from './jobs.mjs';
import { commonMaster } from './hls.mjs';
import { hlsFetchFor } from './page-request.mjs';
import { pageId, readEntry, sendQueue } from './queue.mjs';

const $ = id => document.getElementById(id);
const status = $('status');
const params = new URLSearchParams(location.search);
const sourceId = /^\d+$/.test(params.get('tab') || '') ? Number(params.get('tab')) : null;
const view = params.get('view');
let recovery;
let streamJobFor;
let observedDuringRecovery = [];
let tab, sourceDocument, detectionOn = false, previousOrigins = [];

function message(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function row(section, label, meta, actionLabel, action) {
  const li = element('li');
  const info = element('div', '', 'row-text');
  info.append(element('div', label, 'label'));
  if (meta) info.append(element('div', meta, 'meta'));
  const button = element('button', actionLabel, ['whole', 'files', 'streams'].includes(section) ? '' : 'quiet');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await action(); }
    catch (error) { message(error.message || '操作を完了できませんでした。', true); }
    finally { button.disabled = false; }
  });
  li.append(info, button);
  $(section).hidden = false;
  $(section).querySelector('ul').append(li);
}

function showQueueButton(id) {
  const open = $('open-manager');
  open.textContent = 'キューを開く';
  open.onclick = () => sendQueue('queue-open', {id, sourceTabId:tab.id}).then(() => window.close()).catch(error => message(error.message,true));
}

async function enqueue(job) {
  const opened = await openTransfer({ ...job, tabId: tab?.id, sourceDoc:job.sourceDoc || sourceDocument, sourceUrl: tab?.url, sourceTitle: tab?.title });
  if (opened && ['hls','file'].includes(job.kind) && tab?.url) {
    const id = await pageId(tab.url, !!tab.incognito);
    const {page} = await readEntry(id);
    if (page?.runner === 'engine' && !page.sourcePanel) {
      message('このページでは進捗を表示できません。「キューを開く」で取得状況を確認できます。');
      showQueueButton(id); return opened;
    }
  }
  if (opened && sourceId === null) window.close();
  return opened;
}

function addNote(text) {
  const note = element('p', text, 'note');
  $('notes').append(note);
  return note;
}

async function inspect(autoOpen) {
  const active = sourceId === null ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0] : await chrome.tabs.get(sourceId);
  const site = httpUrl(active?.url);
  if (!site) throw new Error('動画のあるウェブページを開いて、そこで拡張アイコンを押してください。');
  tab = active;
  $('site').textContent = site.host;
  if (autoOpen && sourceId === null && await sendQueue('queue-find', { sourceUrl: site.href, sourceTabId: tab.id })) {
    const id = await pageId(site.href, !!tab.incognito);
    const {page,state} = await readEntry(id);
    if (page?.runner === 'engine' && state?.phase === 'permission' && page.job.tabId === tab.id) {
      message(state.text);
      row(page.job.kind === 'file' ? 'files' : 'streams','配信元の読み取り', '', '許可して取得', async () => {
        if (!await chrome.permissions.request(state.permission)) throw new Error('配信元の読み取りが許可されませんでした。');
        const reply = await chrome.runtime.sendMessage({op:'popup-resume',id,run:page.run,sourceTabId:tab.id});
        if (!reply?.value) throw new Error(reply?.error || '取得を再開できませんでした。');
        window.close();
      });
      return;
    }
    if (page?.runner === 'engine' && page.sourcePanel && page.job.tabId === tab.id) {
      const frame = await chrome.webNavigation.getFrame({tabId:tab.id,frameId:0}).catch(() => null);
      if (frame?.documentId === page.job.sourceDoc) { window.close(); return; }
    }
    message('このページのダウンロードはすでにキューにあります。');
    showQueueButton(id);
    return;
  }
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }) || [];
  const top = frames.find(frame => frame.frameId === 0);
  if (!top || top.url !== active.url && httpUrl(top.url)?.origin !== site.origin) {
    throw new Error('ページが切り替わりました。再検出してください。');
  }
  if (sourceId !== null && params.get('doc') && params.get('doc') !== top.documentId && recovery?.sourceUrl !== top.url) {
    throw new Error('元の動画ページが切り替わりました。動画のタブで拡張を開いてください。');
  }
  const docs = frames.filter(frame => !frame.errorOccurred && httpUrl(frame.url));
  sourceDocument = top.documentId;
  const patterns = [...new Set(docs.filter(frame => httpUrl(frame.url).origin !== site.origin)
    .map(frame => hostPattern(frame.url)))];
  const granted = new Set();
  await Promise.all(patterns.map(async pattern => {
    if (await chrome.permissions.contains({ origins: [pattern] })) granted.add(pattern);
  }));
  const allowed = docs.filter(frame => httpUrl(frame.url).origin === site.origin || granted.has(hostPattern(frame.url)));
  const reports = await Promise.all(allowed.map(async frame => {
    try {
      const [entry] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, documentIds: [frame.documentId] }, files: ['scan.js']
      });
      return { frame, result: entry?.result };
    } catch { return { frame, result: null }; }
  }));
  const whole = new Map();
  const sourceTitle = reports.find(report => report.frame.frameId === 0)?.result?.title;
  if (sourceTitle) tab = { ...active, title:sourceTitle };
  const protectedDocs = new Set(reports.filter(r => r.result?.flags.protected).map(r => r.frame.documentId));
  for (const frame of docs) {
    if (protectedDocs.has(frame.documentId)) continue;
    const candidate = wholeVideo(frame.frameId === 0 ? active.url : frame.url);
    if (!candidate) continue;
    const key = candidate.provider + '/' + candidate.id;
    if (whole.has(key) && frame.frameId !== 0) continue;
    candidate.label = frame.frameId === 0 && tab.title ? tab.title : candidate.host + ' · ' + candidate.id;
    whole.set(key, candidate);
  }
  const snapshot = await chrome.runtime.sendMessage({op:'detected',tabId:tab.id,withHistory:true});
  const detected = Array.isArray(snapshot) ? snapshot : snapshot?.items || [];
  const since = new Map();
  if (snapshot?.frames) {
    const byId = new Map(frames.map(frame => [frame.frameId,frame]));
    for (const {frame,result} of reports) {
      let cutoff = 0;
      for (let doc = frame; doc; doc = byId.get(doc.parentFrameId)) {
        const changed = snapshot.frames[doc.frameId];
        if (changed?.documentId === doc.documentId) cutoff = Math.max(cutoff,changed.since);
      }
      if (!cutoff) continue;
      since.set(frame.documentId,cutoff);
      if (result?.items) result.items = result.items.filter(item => item.source !== 'resource' || item.seenAt >= cutoff);
    }
  }
  const items = reports.flatMap(report => report.result?.items || []);
  const current = new Set(docs.filter(doc => !protectedDocs.has(doc.documentId)).map(doc => doc.documentId));
  const known = new Set();
  const pageSources = new Map();
  const allowedFrames = new Map(allowed.map(frame => [frame.documentId, frame]));
  const nonPlayers = new Set(reports.filter(r => r.result?.documentType &&
    !/^(?:text\/html|application\/xhtml\+xml)$/i.test(r.result.documentType)).map(r => r.frame.documentId));
  const documents = new Map();
  const seenAt = new Map();
  function noteTime(url, time) {
    if (Number.isFinite(time)) seenAt.set(url, Math.max(seenAt.get(url) || 0, time));
  }
  function noteSource(url, frame) {
    if (nonPlayers.has(frame.documentId) || frame.url === url) return;
    pageSources.set(url, { playlistUrl: url, tabId: tab.id, documentId: frame.documentId, documentUrl: frame.url,
      origin: new URL(frame.url).origin, mediaOrigin: new URL(url).origin });
  }
  for (const { frame, result } of reports) {
    for (const item of result?.items || []) {
      const url = fullPlaylistUrl(item.url);
      noteTime(url, item.seenAt);
      documents.set(url, frame.documentId);
      if (!protectedDocs.has(frame.documentId) && item.fromPlayerRequest &&
          (/\.m3u8$/i.test(new URL(url).pathname) || /mpegurl/i.test(item.type))) noteSource(url, frame);
    }
  }
  const recovered = observedDuringRecovery.filter(item => !(item.seenAt < since.get(item.documentId)));
  for (const item of [...detected, ...recovered]) {
    if (!current.has(item.documentId)) continue;
    known.add(item.url);
    noteTime(item.url, item.seenAt);
    const frame = allowedFrames.get(item.documentId);
    if (item.pageOrigin && frame && httpUrl(frame.url)?.origin === item.pageOrigin) {
      noteSource(item.url, frame);
    } else if (pageSources.get(item.url)?.documentId === item.documentId) pageSources.delete(item.url);
    documents.set(item.url, pageSources.get(item.url)?.documentId || item.documentId);
    items.push({ url: item.url, type: 'application/vnd.apple.mpegurl', source: 'resource' });
  }
  for (const frame of docs) {
    if (!protectedDocs.has(frame.documentId) && /\.m3u8$/i.test(httpUrl(frame.url).pathname)) {
      items.push({ url: frame.url, source: 'resource' });
    }
  }
  const { videos, dash } = videosFrom(items, tab.title);
  if (!whole.size && !videos.length && !reports.some(report => report.result)) throw new Error('Chromeがこのページへのアクセスを制限しています。サイトへのアクセス設定を確認してください。');
  const players = reports.flatMap(({ frame, result }) => (result?.players || []).map(player => ({
    ...player, kind: 'record', tabId: tab.id, documentId: frame.documentId, host: httpUrl(frame.url).host
  })));
  if (view === 'capture' && sourceId !== null) {
    if (autoOpen && players.length === 1) {
      await enqueue(players[0]);
      window.close();
      return;
    }
    for (const player of players) row('players', player.label, player.width + '×' + player.height, 'キャプチャを開く', () => enqueue(player));
    message(players.length ? '録画するプレーヤーを選んでください。' : '録画できるプレーヤーが見つかりません。元ページで動画を読み込んでから再検出してください。');
    return;
  }
  const streams = videos.filter(video => video.kind === 'hls');
  streamJobFor = (video, detectedChoice = false) => {
    const url = fullPlaylistUrl(video.url), docId = pageSources.get(url)?.documentId || documents.get(url);
    if (!docId || (video.audioUrl && documents.get(fullPlaylistUrl(video.audioUrl)) !== docId)) return { ...video, sourceDoc:top.documentId };
    const sources = [...pageSources.values()].filter(source => source.documentId === docId);
    const playback = detectedChoice && pageSources.has(url) && reports.find(r => r.frame.documentId === docId)?.result?.playback;
    const samePlayer = playback && (!playback.url || sources.some(s => s.playlistUrl === fullPlaylistUrl(playback.url)));
    return { ...video, url, sourceDoc: top.documentId, observedAt: seenAt.get(url) || Date.now(), pageSources: sources,
      ...(samePlayer ? { playbackResolution: playback.resolution } : {}) };
  };
  const openStream = video => enqueue(streamJobFor(video, true));
  const candidates = [...new Set([...known, ...streams.map(video => video.url)])];
  const previousUrl = recovery?.previous;
  const previous = previousUrl && new URL(previousUrl);
  const fresh = streams.filter(video => {
    if (!previous || video.url === previousUrl || !(seenAt.get(video.url) > (recovery.observedAt || 0))) return false;
    const url = new URL(video.url);
    return url.origin === previous.origin && url.pathname === previous.pathname;
  }).sort((a, b) => seenAt.get(b.url) - seenAt.get(a.url));
  const considered = fresh.length ? candidates.filter(url => url !== previousUrl) : candidates;
  let root = considered.length === 1 ? considered[0] : null;
  if (!root && (!recovery || fresh.length)) {
    root = await commonMaster(considered, requireOrigins, (url, options) => {
      const source = pageSources.get(url);
      return source ? hlsFetchFor([source])(url, options) : fetch(url, options);
    });
  }
  const main = streams.find(video => video.url === root);
  if (autoOpen && sourceId === null) {
    const others = [...whole.values(), ...videos.filter(video => video.kind !== 'hls')];
    if (main && (known.size || !others.length)) { await openStream(main); return; }
    if (!streams.length && others.length === 1) { await enqueue(others[0]); return; }
  }

  const choices = main ? [main] : [...fresh, ...streams.filter(s => !fresh.includes(s) && s.url !== previousUrl)];
  const previousChoice = streams.find(s => s.url === previousUrl);
  if (previousChoice && !choices.includes(previousChoice)) choices.push(previousChoice);
  for (const [index, video] of choices.entries()) {
    const { host, pathname } = new URL(video.url);
    const label = video.leaf || video.label;
    const title = choices.length > 1 ? '候補 ' + (index + 1) + ' · ' + label : label;
    let action = '取得を開始';
    if (fresh.includes(video)) action = '新しく検出したURLで取得';
    if (video.url === previousUrl) action = '前回のURLで再取得';
    row('streams', title, host + pathname, action, () => openStream(video));
  }
  for (const video of whole.values()) {
    row('whole', video.label, video.host, '丸ごと保存', () => enqueue(video));
  }
  for (const video of videos) {
    if (video.kind === 'hls') continue;
    const format = video.extension.toUpperCase() || '動画';
    const size = video.width > 0 ? video.width + '×' + video.height : '';
    const meta = [format, size, timeLabel(video.duration), video.host].filter(Boolean).join(' · ');
    row('files', video.label, meta, 'ダウンロード', () => enqueue(video));
  }
  for (const player of players) {
    row('players', player.label, player.width + '×' + player.height + ' · ' + player.host, 'キャプチャを開く', () => enqueue(player));
  }
  for (const pattern of patterns.filter(pattern => !granted.has(pattern))) {
    row('frames', pattern.slice(0, -2), '', '許可して検出', async () => {
      if (await chrome.permissions.request({ origins: [pattern] })) await refresh();
      else message('埋め込み元の読み取りは許可されませんでした。');
    });
  }
  if (!whole.size && !videos.length && !players.length && !$('frames').hidden) $('frames').open = true;
  for (const hint of providerHints(docs.map(frame => frame.url))) {
    const link = element('a', hint.text);
    link.href = hint.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    addNote(hint.label + ' ').append(link);
  }
  if (reports.some(report => report.result?.flags.protected)) addNote('DRMで保護されたプレーヤーは保存対象外です。');
  if (dash) addNote('DASH配信を検出しました。再生区間を保存するには「キャプチャモード」を選んでください。');
  else if (!videos.length && reports.some(report => report.result?.flags.blob)) addNote('プレーヤー内部の動画を検出しました。録画候補を表示するには、動画を一度再生してください。');
  if (reports.some(report => !report.result)) addNote('読み取れなかった埋め込みがあります。必要に応じて再検出してください。');
  if (streams.length) {
    if (view === 'recover' && fresh.length) message('元ページが読み込んだ別のURLを検出しました。保存する候補を選んでください。');
    else if (view === 'recover') message('元ページを再検出しました。URLが更新されない場合は、元ページを再読み込みしてから「再検出」を押してください。');
    else message('HLSの候補を' + choices.length + '件検出しました。保存する候補を選んでください。');
    return;
  }
  if (whole.size) { message('全編保存の候補が ' + whole.size + ' 件あります。'); return; }
  message(videos.length || players.length
    ? 'ファイル候補 ' + videos.length + ' 件　録画候補 ' + players.length + ' 件'
    : 'まだ動画が見つかりません。動画を少し再生してから再検出してください。');
}

async function refresh(autoOpen = false) {
  streamJobFor = null;
  $('refresh').disabled = true;
  for (const id of ['streams', 'whole', 'files', 'players', 'frames']) {
    $(id).hidden = true;
    $(id).querySelector('ul').replaceChildren();
  }
  $('frames').open = false;
  $('notes').replaceChildren();
  message('ページを調べています…');
  try { await inspect(autoOpen); }
  catch (error) { message(error.message || 'ページを調べられませんでした。', true); }
  finally { $('refresh').disabled = false; }
}

async function showDetection() {
  const [settings, permissions] = await Promise.all([
    chrome.storage.local.get(detectionSetting), chrome.permissions.getAll()
  ]);
  previousOrigins = permissions.origins || [];
  detectionOn = !!settings[detectionSetting] && allSites.every(site => previousOrigins.includes(site));
  $('toggle').textContent = detectionOn ? '自動検出をオフ' : '自動検出をオン';
  $('toggle').disabled = false;
  $('detection').open = !detectionOn;
}
$('toggle').addEventListener('click', async () => {
  $('toggle').disabled = true;
  try {
    if (detectionOn) {
      const { detectionOrigins = [] } = await chrome.storage.local.get('detectionOrigins');
      await chrome.storage.local.remove([detectionSetting, 'detectionOrigins']);
      if (detectionOrigins.length) await chrome.permissions.remove({ origins: detectionOrigins });
      message('自動検出をオフにしました。');
    } else if (await chrome.permissions.request({ origins: allSites })) {
      await chrome.storage.local.set({ [detectionSetting]: true, detectionOrigins: allSites.filter(site => !previousOrigins.includes(site)) });
      message('自動検出をオンにしました。動画ページを再読み込みするか、再生してください。');
    } else message('配信元の読み取りは許可されませんでした。');
  } catch (error) { message(error.message, true); }
  finally { await showDetection(); }
});
$('refresh').addEventListener('click', () => refresh());
$('open-manager').onclick = () => sendQueue('queue-index', { sourceTabId: tab?.id,
  incognito: chrome.extension.inIncognitoContext }).catch(error => message(error.message, true));
$('hls-form').addEventListener('submit', async event => {
  event.preventDefault();
  const url = httpUrl($('hls-url').value.trim());
  if (!url) { message('HTTPまたはHTTPSのプレイリストURLを入力してください。', true); return; }
  url.hash = '';
  const audioText = $('hls-audio').value.trim();
  const audio = audioText && httpUrl(audioText);
  if (audioText && !audio) { message('音声のHTTPまたはHTTPSのプレイリストURLを確認してください。', true); return; }
  if (audio) audio.hash = '';
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const { videos: [job] } = videosFrom([{ url: url.href, type: 'application/vnd.apple.mpegurl' }]);
    if (audio && audio.href !== url.href) job.audioUrl = audio.href;
    await enqueue(streamJobFor ? streamJobFor(job) : job);
  } catch (error) { message(error.message || 'HLS保存画面を開けませんでした。', true); }
  finally { button.disabled = false; }
});
showDetection().catch(error => message(error.message, true));
async function initialize() {
  if (view === 'recover' && sourceId !== null) {
    recovery = await readJob();
    if (recovery?.previous) {
      // This listener lives only in the recovery tab, including when passive detection is switched off.
      const origin = new URL(recovery.previous).origin;
      const remember = details => {
        const item = playlistResponse(details);
        if (item && new URL(item.url).origin === origin) observedDuringRecovery = rememberStream(observedDuringRecovery, item);
      };
      chrome.webRequest.onResponseStarted.addListener(remember, { tabId: sourceId, urls: [hostPattern(origin)] }, ['responseHeaders']);
      addEventListener('pagehide', () => chrome.webRequest.onResponseStarted.removeListener(remember), { once: true });
    }
  }
  await refresh(true);
}
initialize().catch(error => message(error.message, true));
