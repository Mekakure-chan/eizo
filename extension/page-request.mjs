// A selected, observed manifest defines its rendition/segment URLs, including on other CDNs.
// Every document-based read still uses ordinary anonymous CORS. A manual URL has no such context.
export function hlsFetchFor(sources = [], rootUrl, onDisconnect) {
  if (!sources.length) return fetch;
  const playlists = new Map(sources.map(source => [source.playlistUrl, source]));
  const selected = playlists.get(rootUrl);
  const root = selected && selected.mediaOrigin === new URL(rootUrl).origin ? selected : undefined;
  const active = new Map();
  return (url, options) => {
    const origin = new URL(url).origin;
    const observed = playlists.get(url);
    const source = observed?.mediaOrigin === origin ? observed : root;
    if (source && !active.has(origin)) active.set(origin, pageReader({ ...source, mediaOrigin: origin }, onDisconnect));
    return (active.get(origin) || fetch)(url, options);
  };
}

function pageReader(source, onDisconnect) {
  let installed;
  return async (url, options) => {
    options.signal?.throwIfAborted();
    installed ??= chrome.scripting.executeScript({
      target: { tabId: source.tabId, documentIds: [source.documentId] }, files: ['page-reader.js']
    }).catch(() => { installed = null; throw unavailable(onDisconnect); });
    await installed;
    options.signal?.throwIfAborted();
    let port;
    try { port = chrome.tabs.connect(source.tabId, { documentId: source.documentId, name: 'embedded-hls-reader' }); }
    catch { throw unavailable(onDisconnect); }
    return readResponse(port, source, url, options, onDisconnect);
  };
}

export async function fetchDetached(url, options) {
  const response = await fetch(url, options);
  response.detachedOrigin = new URL(response.url || url).origin;
  return response;
}

function unavailable(onDisconnect) {
  const error = new Error(onDisconnect ? 'プレーヤーとの接続が続きませんでした。キューの「再取得」からやり直せます。'
    : '取得に使用するプレーヤーとの接続が切れました。元ページを開いて再検出してください。');
  error.pageUnavailable = true;
  if (onDisconnect) {
    onDisconnect();
    error.readerDisconnected = true;
    error.retryable = true;
  }
  return error;
}

function readResponse(port, source, url, { headers, cache, signal }, onDisconnect) {
  return new Promise((resolve, reject) => {
    let body, pending, closed = false;
    function close(error) {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', abort);
      if (error) { reject(error); body?.error(error); }
      pending?.();
      port.disconnect();
    }
    const abort = () => close(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (!closed) close(unavailable(onDisconnect)); });
    port.onMessage.addListener(msg => {
      if (closed) return;
      try {
        if (msg.type === 'error') {
          const error = msg.documentLost ? unavailable(onDisconnect) : new Error(new URL(url).host + ' の応答をプレーヤー経由で読み取れません。配信元の読み取り許可や通信状況を確認してください。');
          if (!msg.documentLost) error.pageReadFailed = true;
          close(error);
          return;
        }
        if (msg.type === 'head') {
          const stream = new ReadableStream({
            start(controller) { body = controller; },
            pull() {
              return new Promise(done => {
                pending = done;
                try { port.postMessage({ type: 'read' }); } catch { close(unavailable(onDisconnect)); }
              });
            },
            cancel() { close(); }
          }, { highWaterMark: 0 });
          resolve({ status: msg.status, ok: msg.status >= 200 && msg.status < 300, url: msg.url, fromPlayer: true,
            headers: new Headers(msg.headers), body: stream });
        } else if (msg.type === 'data') {
          body.enqueue(Uint8Array.from(atob(msg.chunk), c => c.charCodeAt(0)));
          const done = pending; pending = null; done?.();
        } else if (msg.type === 'end') {
          body.close();
          close();
        }
      } catch (error) { close(error); }
    });
    if (signal?.aborted) { abort(); return; }
    try { port.postMessage({ type: 'open', url, origin: source.origin, mediaOrigin: source.mediaOrigin,
      range: headers?.Range, fresh: cache === 'no-store' }); }
    catch { close(unavailable(onDisconnect)); }
  });
}
