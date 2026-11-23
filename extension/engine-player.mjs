import { httpUrl } from './media.mjs';
import { fetchDetached } from './page-request.mjs';
import { readOverPort } from './engine-wire.mjs';

export async function host(op, fields = {}) {
  const reply = await chrome.runtime.sendMessage({ destination:'hls-host', op, ...fields });
  if (!reply?.ok) throw Object.assign(new Error(reply?.error || '取得処理と通信できませんでした。'), reply?.flags);
  return reply.value;
}
const lost = () => Object.assign(new Error('プレーヤーとの接続が切れました。'), { pageUnavailable:true, readerDisconnected:true, retryable:true });

function probe(frame, source, signal) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = value => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      channel.port1.close(); resolve(value);
    };
    const cancel = () => finish(null);
    const timer = setTimeout(cancel, 180);
    channel.port1.onmessage = ({data}) => finish(data);
    signal.addEventListener('abort', cancel, {once:true});
    try { frame.contentWindow.postMessage({op:'probe',documentUrl:source.documentUrl}, source.origin, [channel.port2]); }
    catch { channel.port2.close(); cancel(); }
  });
}

export async function enginePlayer(page, signal, report) {
  const job = page.job;
  const sources = (job.pageSources || []).filter(s => s.tabId === job.tabId && httpUrl(s.documentUrl)?.origin === s.origin &&
    httpUrl(s.playlistUrl)?.origin === s.mediaOrigin);
  const source = sources.find(s => s.playlistUrl === job.url);
  const key = { id:page.id, run:page.run };
  const frame = document.createElement('iframe');
  let canEmbed = source && 'credentialless' in frame && source.documentId !== job.sourceDoc &&
    source.documentUrl.split('#')[0] !== job.sourceUrl.split('#')[0];
  let lease, preparing, loaded = 0, registered = false, mode;
  const readDirect = source ? fetchDetached : fetch;
  function setMode(next) {
    if (next === mode) return;
    mode = next;
    report('配信の取得を準備しています…', undefined, { readerMode:next });
  }
  frame.hidden = true; frame.sandbox = 'allow-same-origin'; frame.allow = "autoplay 'none'"; frame.referrerPolicy = 'no-referrer';
  frame.onload = frame.onerror = () => { loaded = Date.now(); lease?.abort(lost()); lease = null; };
  async function prepareFrame(io) {
    if (!frame.isConnected) {
      try { await host('frame-start', key); }
      catch (error) {
        if (error.origins || error.permission) throw error;
        // If this Chrome context cannot host an iframe, the verified source document may still be available.
        canEmbed = false;
        return;
      }
      registered = true;
      io.throwIfAborted();
      frame.credentialless = true; frame.src = source.documentUrl;
      document.body.append(frame);
    }
    const until = Date.now() + 12000;
    do {
      io.throwIfAborted();
      if (!loaded && Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 60)); continue; }
      const doc = await probe(frame, source, io);
      const status = doc && (doc.status || await host('frame-status', key));
      if (doc && /^(text\/html|application\/xhtml\+xml)$/i.test(doc.type) && (status === 304 || status >= 200 && status < 300)) {
        lease = new AbortController(); setMode('queue'); return;
      }
      if (status >= 400 || (loaded && Date.now() - loaded >= 450) || Date.now() >= until) {
        const responseStatus = status || await host('frame-status', key);
        if (responseStatus >= 400) throw Object.assign(new Error('配信元がプレーヤーの読み込みを拒否しました（HTTP ' + responseStatus + '）。'), {pageUnavailable:true,status:responseStatus});
        canEmbed = false; frame.remove();
        await host('frame-end', key); registered = false; return;
      }
    } while (true);
  }
  async function fetchResource(url, options) {
    const io = options.signal || signal;
    io.throwIfAborted();
    if (canEmbed && !lease) {
      preparing ??= prepareFrame(io).finally(() => { preparing = null; });
      await preparing; io.throwIfAborted();
    }
    const range = options.headers?.Range, fresh = options.cache === 'no-store';
    if (lease) {
      const lifetime = lease.signal;
      return readOverPort(port => frame.contentWindow.postMessage({op:'read',documentUrl:source.documentUrl,url,range,fresh}, source.origin, [port]), io, lost, lifetime);
    }
    const target = source && await host('original', key);
    io.throwIfAborted();
    if (!target) { setMode(source ? 'detached' : 'queue'); return readDirect(url, options); }
    setMode('original');
    const controller = navigator.serviceWorker.controller || (await navigator.serviceWorker.ready).active;
    return readOverPort(port => controller.postMessage({op:'read-original', ...key, target, url, range, fresh}, [port]), io, lost);
  }
  return { fetchResource, async dispose() {
    lease?.abort(lost()); frame.onload = frame.onerror = null; frame.remove();
    if (registered) await host('frame-end', key).catch(() => {});
  } };
}
