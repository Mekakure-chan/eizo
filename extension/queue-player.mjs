import { hostPattern, httpUrl } from './media.mjs';
import { tabKey } from './discovery.mjs';
import { requireOrigins } from './jobs.mjs';
import { fetchDetached, hlsFetchFor } from './page-request.mjs';

function networkUrl(value) {
  const url = httpUrl(value);
  if (url) url.hash = '';
  return url?.href;
}

function playerError(text) {
  const error = new Error(text);
  error.pageUnavailable = true;
  return error;
}

function navigationEvidence(tabId, url) {
  const responses = new Map();
  const observe = details => {
    if (networkUrl(details.url) !== networkUrl(url)) return;
    responses.set(details.frameId, details.statusCode);
  };
  chrome.webRequest.onHeadersReceived.addListener(observe,
    { tabId, urls: [hostPattern(url)], types: ['main_frame', 'sub_frame'] });
  return { responses, stop: () => chrome.webRequest.onHeadersReceived.removeListener(observe) };
}

async function findDocument(tabId, source, evidence) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  const frame = frames?.find(f => !f.errorOccurred && networkUrl(f.url) === networkUrl(source.documentUrl));
  if (!frame) return null;
  const checked = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [frame.documentId] }, injectImmediately: true,
    func: () => {
      if (document.readyState === 'loading') return null;
      const nav = performance.getEntriesByType('navigation')[0];
      return { origin: location.origin, type: document.contentType, status: nav?.responseStatus };
    }
  }).catch(() => []);
  const doc = checked[0]?.result;
  if (!doc || doc.origin !== source.origin) return null;
  const status = doc.status || evidence.get(frame.frameId);
  if (!status) return null;
  if (status && status !== 304 && (status < 200 || status >= 300)) throw playerError('配信元がプレーヤーの読み込みを拒否しました（HTTP ' + status + '）。');
  if (!/^(text\/html|application\/xhtml\+xml)$/i.test(doc.type)) return null;
  return { tabId, documentId: frame.documentId };
}

async function embeddedTarget(tabId, source, signal, responses, frame) {
  if (frame.isConnected) {
    const existing = await findDocument(tabId, source, responses);
    if (existing) return existing;
    frame.remove();
  }
  responses.clear();
  let loadedAt = 0;
  frame.onload = frame.onerror = () => { loadedAt = Date.now(); };
  frame.src = source.documentUrl;
  document.body.append(frame);
  const until = Date.now() + 15000;
  try {
    do {
      signal.throwIfAborted();
      const denied = [...responses.values()].find(status => status >= 400);
      if (denied) throw playerError('配信元がプレーヤーの読み込みを拒否しました（HTTP ' + denied + '）。');
      const found = await findDocument(tabId, source, responses);
      if (found || (loadedAt && Date.now() - loadedAt >= 450)) return found;
      await new Promise(resolve => setTimeout(resolve, 150));
    } while (Date.now() < until);
    return null;
  } finally { frame.onload = frame.onerror = null; }
}

export async function originalTarget(job, source) {
  if (!Number.isInteger(job.tabId) || source.tabId !== job.tabId || !job.sourceDoc || !source.documentId) return null;
  const frames = await chrome.webNavigation.getAllFrames({ tabId: job.tabId }).catch(() => null);
  const active = f => !f.errorOccurred && (!f.documentLifecycle || f.documentLifecycle === 'active');
  if (!frames?.some(f => f.frameId === 0 && active(f) && f.documentId === job.sourceDoc && f.url === job.sourceUrl)) return null;
  const matches = frames.filter(f => active(f) && f.url === source.documentUrl);
  let frame = matches.find(f => f.documentId === source.documentId);
  if (!frame && matches.length) {
    // A site can recreate its player in the same watch document. Require a fresh observation from the replacement.
    const key = tabKey(job.tabId);
    const seen = (await chrome.storage.session.get(key))[key] || [];
    frame = matches.find(f => seen.some(s => s.documentId === f.documentId && s.url === source.playlistUrl && s.pageOrigin === source.origin));
  }
  return frame ? { tabId: job.tabId, documentId: frame.documentId } : null;
}

export async function queuePlayer(job, signal, report) {
  const sources = (job.pageSources || []).filter(s => httpUrl(s.documentUrl)?.origin === s.origin &&
    httpUrl(s.playlistUrl)?.origin === s.mediaOrigin && s.tabId === job.tabId);
  if (!sources.length) {
    report('キューから取得しています…', null, { readerMode: 'queue' });
    return { fetchResource: fetch, dispose() {} };
  }
  const source = sources.find(s => s.playlistUrl === job.url) || sources[0];
  const sameDocument = sources.filter(s => s.documentId === source.documentId && s.documentUrl === source.documentUrl);
  const tab = await chrome.tabs.getCurrent();
  const frame = document.createElement('iframe');
  let canEmbed = 'credentialless' in frame && source.documentId !== job.sourceDoc && networkUrl(source.documentUrl) !== networkUrl(job.sourceUrl);
  frame.hidden = true;
  frame.sandbox = 'allow-same-origin';
  frame.allow = "autoplay 'none'";
  if (canEmbed) frame.credentialless = true;
  frame.referrerPolicy = 'no-referrer';
  let reader, connecting, navigation, original;
  function dispose() {
    navigation?.stop();
    frame.remove();
  }
  async function connect(io) {
    io.throwIfAborted();
    await requireOrigins([source.documentUrl]);
    let target;
    if (canEmbed) {
      navigation ??= navigationEvidence(tab.id, source.documentUrl);
      target = await embeddedTarget(tab.id, source, io, navigation.responses, frame);
      if (!target) { canEmbed = false; dispose(); navigation = null; }
    }
    original = target ? null : await originalTarget(job, source);
    io.throwIfAborted();
    target ??= original;
    const mode = original ? 'original' : target ? 'queue' : 'detached';
    report('配信の取得を準備しています…', undefined, { readerMode: mode });
    if (!target) { reader = fetchDetached; return reader; }
    const next = hlsFetchFor(sameDocument.map(s => ({ ...s, ...target })), job.url, () => {
      if (reader !== next) return;
      reader = null;
      report('プレーヤーに再接続しています。取得済みの区間は保持しています。');
    });
    reader = next;
    return next;
  }
  async function currentReader(io) {
    io.throwIfAborted();
    // A history/fragment navigation can change the video without changing its document ID.
    if (reader && original) {
      const previous = reader;
      const current = await originalTarget(job, source);
      if (reader === previous && current?.documentId !== original?.documentId) reader = null;
    }
    if (reader) return reader;
    connecting ??= connect(io).finally(() => { connecting = null; });
    return connecting;
  }
  try {
    await currentReader(signal);
    return { async fetchResource(url, options) {
      const io = options.signal || signal;
      const read = await currentReader(io);
      io.throwIfAborted();
      return read(url, options);
    }, dispose };
  } catch (error) { dispose(); throw error; }
}
