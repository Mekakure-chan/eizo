// Used only in the worker and in the extension's sandboxed player iframe.
(() => {
  if (typeof window !== 'undefined' && (window === top || location.ancestorOrigins[0] !== new URL(chrome.runtime.getURL('')).origin)) return;
  if (globalThis.embeddedVideoServeRead) return;
  globalThis.embeddedVideoServeRead = async (port, fetchResponse) => {
    const controller = new AbortController();
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    let reader, busy = false, closed = false;
    function end() {
      if (closed) return;
      closed = true; controller.abort();
      reader?.cancel().catch(() => {}); port.close(); finish();
    }
    function fail(error) {
      if (closed) return;
      const flags = {};
      for (const key of ['status','retryable','readerDisconnected','pageUnavailable','pageReadFailed']) {
        if (error[key] !== undefined) flags[key] = error[key];
      }
      port.postMessage({type:'error', message:error.message, flags}); end();
    }
    port.onmessage = async ({data}) => {
      if (data.type === 'cancel') { end(); return; }
      if (data.type !== 'pull' || busy || closed) return;
      busy = true;
      try {
        const chunk = await reader?.read();
        if (closed) return;
        if (!chunk || chunk.done) { port.postMessage({type:'end'}); end(); }
        else {
          const bytes = chunk.value.slice();
          port.postMessage({type:'chunk', bytes}, [bytes.buffer]);
        }
      } catch (error) { fail(error); }
      finally { busy = false; }
    };
    try {
      const response = await fetchResponse(controller.signal);
      if (closed) { await response.body?.cancel().catch(() => {}); return; }
      reader = response.body?.getReader();
      const headers = {};
      for (const name of ['content-length','content-range','content-encoding']) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      port.postMessage({type:'head', status:response.status, url:response.url, fromPlayer:!!response.fromPlayer, headers});
    } catch (error) { fail(error); }
    return finished;
  };
})();
