// The result of this expression is returned by chrome.scripting.executeScript.
(() => {
  const items = [];
  const players = [];
  let playback;
  const flags = { blob: false, protected: false };
  const visited = new Set();
  // Let an expired panel restore the publisher's title before reading it for a new job.
  if (window === top && !globalThis.embeddedVideoSourcePanel) document.dispatchEvent(new Event('embedded-video-check-source-panel'));
  const title = globalThis.embeddedVideoSourcePanel?.title ?? document.title;
  const targets = globalThis.embeddedVideoSaverTargets ??= { ids: new WeakMap(), elements: new Map(), next: 0 };
  targets.elements.clear();

  function inspectDocument(doc) {
    if (!doc || visited.has(doc)) return;
    visited.add(doc);
    const pageTitle = doc === document ? title : doc.title;
    const media = [];
    const meta = [];
    const nested = [];

    function visit(root) {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (el.localName === 'video') media.push(el);
        if (el.localName === 'meta' && ['og:video', 'og:video:url', 'og:video:secure_url'].includes(el.getAttribute('property'))) {
          meta.push(el.content);
        }
        if (el.localName === 'iframe' || el.localName === 'frame') {
          const child = el.contentDocument;
          if (child && ['about:blank', 'about:srcdoc'].includes(child.URL)) nested.push(child);
        }
      }
    }
    visit(doc);

    function add(value, details) {
      if (!value) return;
      let url;
      try { url = new URL(value, doc.baseURI); } catch { return; }
      if (url.protocol === 'blob:') flags.blob = true;
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
      url.hash = '';
      items.push({ url: url.href, page: pageTitle, ...details });
    }

    let protectedPlayer = false;
    for (const video of media) {
      if (video.mediaKeys) {
        protectedPlayer = true;
        flags.protected = true;
        continue;
      }
      if (video.srcObject) flags.blob = true;
      const label = video.getAttribute('aria-label') || video.title;
      const current = video.currentSrc;
      if ((current || video.srcObject) && typeof video.captureStream === 'function' && video.videoWidth > 0) {
        if (!targets.ids.has(video)) targets.ids.set(video, String(++targets.next));
        const id = targets.ids.get(video);
        targets.elements.set(id, video);
        players.push({ id, label: label || pageTitle || 'ページ内の動画', width: video.videoWidth, height: video.videoHeight });
      }
      const sources = [...video.querySelectorAll('source[src]')];
      const type = sources.find(source => source.src === current)?.type || '';
      const size = { width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : null };
      if (doc === document && media.length === 1 && current && !video.srcObject && size.width > 0 && size.height > 0) {
        playback = { resolution: size.width + 'x' + size.height, url: current.startsWith('blob:') ? null : current };
      }
      add(current, { label, type, source: 'video', ...size });
      add(video.getAttribute('src'), { label, source: 'video' });
      for (const source of sources) add(source.src, { label, type: source.type, source: 'video' });
    }
    if (!protectedPlayer) {
      for (const url of meta) add(url, { source: 'meta' });
      for (const entry of doc.defaultView.performance.getEntriesByType('resource')) {
        if (entry.initiatorType === 'video' || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(entry.name) || /mpegurl|dash\+xml/i.test(entry.contentType || '')) {
          if (entry.responseStatus >= 400) continue;
          const fromPlayerRequest = doc === document && ['fetch', 'xmlhttprequest'].includes(entry.initiatorType);
          add(entry.name, { source: 'resource', type: entry.contentType || '', fromPlayerRequest,
            seenAt: doc.defaultView.performance.timeOrigin + entry.startTime });
        }
      }
    }
    for (const child of nested) inspectDocument(child);
  }

  inspectDocument(document);
  return { items, players, playback, flags, title, documentType: document.contentType };
})()
