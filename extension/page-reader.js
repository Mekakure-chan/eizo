// Runs in the isolated world of the document which loaded the selected playlist.
(() => {
  if (globalThis.embeddedHlsPageReader) return;
  globalThis.embeddedHlsPageReader = true;
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'embedded-hls-reader' || port.sender?.id !== chrome.runtime.id ||
        !port.sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    const cancel = new AbortController();
    port.onDisconnect.addListener(() => cancel.abort());
    const send = msg => { if (!cancel.signal.aborted) port.postMessage(msg); };
    let reader, remainder, opened = false, reading = false;
    port.onMessage.addListener(async msg => {
      try {
        if (msg.type === 'open' && !opened) {
          opened = true;
          const url = new URL(msg.url);
          if (location.origin !== msg.origin) { send({ type: 'error', documentLost: true }); return; }
          if (url.origin !== msg.mediaOrigin || !['https:', 'http:'].includes(url.protocol) ||
              url.username || url.password || (msg.range && !/^bytes=\d+-\d+$/.test(msg.range))) {
            send({ type: 'error' }); return;
          }
          // Chrome applies the publisher document's referrer policy and performs the CORS check.
          const response = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit',
            cache: msg.fresh ? 'no-store' : 'default',
            headers: msg.range ? { Range: msg.range } : {}, signal: cancel.signal });
          reader = response.body?.getReader();
          const headers = {};
          for (const name of ['content-range', 'content-length', 'content-encoding']) {
            const value = response.headers.get(name);
            if (value !== null) headers[name] = value;
          }
          send({ type: 'head', url: response.url, status: response.status, headers });
        } else if (msg.type === 'read' && opened && !reading) {
          reading = true;
          if (!remainder?.length) remainder = (await reader?.read())?.value;
          if (!remainder?.length) { send({ type: 'end' }); return; }
          const bytes = remainder.subarray(0, 192 * 1024);
          remainder = remainder.subarray(bytes.length);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          send({ type: 'data', chunk: btoa(binary) });
          reading = false;
        }
      } catch { send({ type: 'error' }); }
    });
  });
})();
