// The extension creates this credentialless iframe with publisher scripts and playback disabled.
(() => {
  const extension = new URL(chrome.runtime.getURL('')).origin;
  if (parent === window || location.ancestorOrigins[0] !== extension || globalThis.embeddedVideoFrameListener) return;
  globalThis.embeddedVideoFrameListener = true;
  addEventListener('message', event => {
    const port = event.ports[0], msg = event.data;
    if (!port || event.origin !== extension || event.source !== parent || msg?.documentUrl !== location.href) return;
    if (msg.op === 'probe') {
      port.postMessage({ type:document.contentType, status:performance.getEntriesByType('navigation')[0]?.responseStatus });
      port.close(); return;
    }
    if (msg.op !== 'read') return;
    globalThis.embeddedVideoServeRead(port, async signal => {
      const url = new URL(msg.url);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password ||
          (msg.range && !/^bytes=\d+-\d+$/.test(msg.range))) throw new Error('読み取る区間を確認できません。');
      try {
        const r = await fetch(url, { signal, mode:'cors', credentials:'omit', cache:msg.fresh ? 'no-store' : 'default',
          headers:msg.range ? { Range:msg.range } : {} });
        return { status:r.status, url:r.url, headers:r.headers, body:r.body, fromPlayer:true };
      } catch (error) {
        if (signal.aborted) throw error;
        throw Object.assign(new Error(url.host + ' の応答をプレーヤー経由で読み取れません。'), { pageReadFailed:true });
      }
    });
  });
})();
