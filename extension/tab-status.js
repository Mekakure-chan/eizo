// Loaded in the isolated source document and in individual extension queues.
(() => {
  if (globalThis.embeddedVideoTabIndicator) return;
  const idleAfter = 60_000;
  const badges = {
    active: ['#1767bf', '#fff', 'M8 3h4v6h3.5L10 15 4.5 9H8z'],
    writing: ['#783db9', '#fff', 'M5.4 3.5h9.2l2.6 6.5H2.8z M2.5 11.5h15V15a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15z M12.5 13h2.5v2h-2.5z'],
    waiting: ['#ffc04b', '#422700', 'M5 4h3.5v12H5zm6.5 0H15v12h-3.5z'],
    error: ['#be3342', '#fff', 'M8 3.5h4l-.6 8H8.6zm.3 10h3.4V17H8.3z'],
    ready: ['#13834d', '#fff', 'M2.6 10.3l2.3-2.4 3.5 3.4 6.8-7 2.3 2.2-9.1 9.5z'],
    saved: ['#52627a', '#fff', 'M3.5 3.5h10.7l2.3 2.4v10.6h-13z M6.5 4.5v4H13v-4z M6.5 11v4h7v-4z']
  };
  const urls = {};
  for (const [kind, [surface, ink, path]] of Object.entries(badges)) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 20 20">' +
      '<rect x=".5" y=".5" width="19" height="19" rx="4" fill="' + surface + '" stroke="#fff" stroke-opacity=".45"/>' +
      '<path fill="' + ink + '" fill-rule="evenodd" d="' + path + '"/></svg>';
    urls[kind] = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  const selector = 'link[rel~="icon" i]';
  globalThis.embeddedVideoTabIndicator = () => {
    const marker = document.createElement('link');
    // Pages can clone the whole head. Mark our edits so copies can also be restored.
    const tag = 'data-evs-icon-' + crypto.getRandomValues(new Uint32Array(2)).join('-');
    marker.setAttribute(tag, 'badge');
    const muted = new Set();
    let kind, head, timer, repair, started, allowed = false;
    function restore(link) {
      const value = link.getAttribute(tag);
      if (value === null) return;
      link.removeAttribute(tag);
      if (value === 'badge') {
        if (Object.values(urls).includes(link.href)) link.remove();
        return;
      }
      if (link.media !== 'not all') return;
      if (value === 'absent') link.removeAttribute('media');
      else if (value.startsWith('media:')) link.media = value.slice(6);
    }
    function sync() {
      if (!allowed || !kind || !document.head) return;
      if (head !== document.head) {
        head = document.head;
        changes.disconnect();
        changes.observe(document.documentElement, {childList:true});
        changes.observe(head, {childList:true, subtree:true, attributes:true, attributeFilter:['rel','media','href','sizes','type']});
      }
      for (const link of muted) {
        if (!head.contains(link) || !link.matches(selector)) { restore(link); muted.delete(link); }
      }
      // Chrome may keep an equally suitable publisher icon even when our link comes last.
      // Keep the original nodes, URLs and any media queries the publisher sets during the download.
      for (const link of head.querySelectorAll(selector)) {
        if (link === marker) continue;
        if (link.getAttribute(tag) === 'badge') {
          restore(link);
          if (!link.isConnected) continue;
        }
        if (link.media !== 'not all') {
          const original = link.getAttribute('media');
          link.setAttribute(tag, original === null ? 'absent' : 'media:' + original);
          link.media = 'not all';
        }
        if (link.hasAttribute(tag)) muted.add(link);
      }
      if (marker.rel !== 'icon') marker.rel = 'icon';
      if (marker.type !== 'image/svg+xml') marker.type = 'image/svg+xml';
      if (marker.sizes.value !== 'any') marker.sizes.value = 'any';
      if (marker.hasAttribute('media')) marker.removeAttribute('media');
      if (marker.href !== urls[kind]) marker.href = urls[kind];
      if (marker.parentNode !== head) head.append(marker);
    }
    const changes = new MutationObserver(() => {
      repair ??= setTimeout(() => { repair = undefined; sync(); }, 80);
    });
    function removeIcon() {
      changes.disconnect();
      clearTimeout(repair); repair = undefined;
      const marked = document.head?.querySelectorAll('link[' + tag + ']') || [];
      const installed = marker.isConnected || Array.from(marked).some(link => link.getAttribute(tag) === 'badge');
      marker.remove();
      for (const link of marked) if (link !== marker) restore(link);
      for (const link of muted) restore(link);
      muted.clear();
      head = null;
      // After same-document navigation Chrome may still display the removed badge.
      // Reannounce the publisher's current URLs once the navigation has committed.
      if (installed && marked.length) setTimeout(() => {
        for (const link of marked) {
          const href = link.getAttribute('href');
          if (!href || !link.isConnected || !link.matches(selector) || link.media === 'not all') continue;
          link.removeAttribute('href');
          link.setAttribute('href', href);
        }
      }, 0);
      // With no declared icon, removing a link alone leaves Chrome showing the previous one.
      if (installed && document.head && !document.head.querySelector(selector) && /^https?:$/.test(location.protocol)) {
        const fallback = document.createElement('link');
        fallback.rel = 'icon'; fallback.href = new URL('/favicon.ico', location.origin).href;
        document.head.append(fallback);
      }
    }
    function denied(event) {
      if (event.isTrusted && event.disposition === 'enforce' && event.effectiveDirective === 'img-src' && event.blockedURI === 'data') {
        allowed = false; removeIcon();
      }
    }
    document.addEventListener('securitypolicyviolation', denied);
    const probe = new Image();
    probe.onload = () => { allowed = true; sync(); };
    probe.src = urls.active;

    function show({phase, progressAt, saveStage, partial, folderPermission}, caption) {
      clearTimeout(timer);
      if (phase === 'fetching') started = progressAt || started || Date.now(); else started = undefined;
      const remaining = started === undefined ? null : started + idleAfter - Date.now();
      function paint(mark, label) {
        if (kind !== mark) { kind = mark; sync(); }
        caption(label);
      }
      if (remaining !== null && remaining <= 0) return paint('waiting', '進捗更新待ち');
      if (remaining !== null) timer = setTimeout(() => paint('waiting', '進捗更新待ち'), remaining);
      if (phase === 'fetching' || phase === 'recording') paint('active');
      else if (phase === 'saving' && saveStage !== 'choosing') paint('writing');
      else if (phase === 'ready' && !folderPermission) paint(partial ? 'waiting' : 'ready', partial ? '一部取得・保存待ち' : undefined);
      else if (phase === 'saved') paint('saved');
      else if (['failed','mergeFailed','interrupted'].includes(phase)) paint('error');
      else paint('waiting');
    }
    function close() {
      clearTimeout(timer);
      kind = undefined;
      probe.onload = null;
      document.removeEventListener('securitypolicyviolation', denied);
      removeIcon();
    }
    return { show, close };
  };
})();
