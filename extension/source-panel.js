// Installed in the isolated world of the selected watch document only.
(() => {
  if (window !== top || !/^(text\/html|application\/xhtml\+xml)$/i.test(document.contentType)) return null;
  if (globalThis.embeddedVideoSourcePanel) return location.href;
  // A previous extension instance can still own DOM listeners in this document.
  const checkPanel = 'embedded-video-check-source-panel';
  document.dispatchEvent(new Event(checkPanel));
  let active;
  globalThis.embeddedVideoSourcePanel = { get title() { return active?.title ?? document.title; } };
  function mount(view) {
    const originalUrl = location.href, run = view.run, id = view.id;
    let originalTitle = document.title, appliedTitle, tabCaption, titleTimer, closed = false, terminalPhase;
    const tabIndicator = globalThis.embeddedVideoTabIndicator();
    const host = document.createElement('div');
    host.setAttribute('data-embedded-video-download', '');
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { all: initial !important; position: fixed !important;
        top: max(12px, env(safe-area-inset-top)) !important; right: max(12px, env(safe-area-inset-right)) !important;
        display: block !important; width: min(300px, calc(100% - 24px)) !important; z-index: 2147483647 !important; }
      section { --accent: #006c70; --surface: #e9fcfa; box-sizing: border-box; direction: ltr; color-scheme: only light;
        color: #163337; background: var(--surface); border: 1px solid var(--accent); border-top-width: 5px;
        border-radius: 10px; box-shadow: 0 4px 18px #10282c40; padding: 12px 14px 14px;
        max-height: calc(100dvh - 24px); overflow: auto; overflow-wrap: anywhere;
        font: 14px/1.5 "Yu Gothic UI", Meiryo, system-ui, sans-serif; text-align: left; }
      section[data-phase="ready"] { --accent: #784000; --surface: #fff1ad; }
      section[data-phase="saving"] { --accent: #68399a; --surface: #f4edff; }
      section:is([data-phase="saveQueued"], [data-phase="permission"], [data-phase="updateRetry"]) { --accent: #74500e; --surface: #fff4d6; }
      section:is([data-phase="failed"], [data-phase="interrupted"], [data-phase="mergeFailed"]) { --accent: #a52d3c; --surface: #fff0f0; }
      strong { display: flex; align-items: center; gap: 9px; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
      section[data-phase="ready"] strong::before { content: ""; flex: none; width: 13px; height: 7px;
        border: solid var(--accent); border-width: 0 0 3px 3px; transform: translateY(-2px) rotate(-45deg); }
      progress { accent-color: var(--accent); width: 100%; height: 8px; display: block; margin-top: 7px; }
      p { margin: 6px 0 0; }
      footer { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
      button.open { margin-inline-start: auto; }
      button { font: inherit; font-weight: 600; border-radius: 6px; border: 1px solid #627777; background: #fff;
        color: #163337; padding: 5px 12px; min-height: 34px; cursor: pointer; }
      button.primary { border-color: var(--accent); background: var(--accent); color: #fff; min-width: 76px; }
      button:hover { text-decoration: underline; }
      button:focus-visible { outline: 3px solid #174eae; outline-offset: 2px; }
      [hidden] { display: none; }
    `);
    root.adoptedStyleSheets = [sheet];
    const make = tag => document.createElement(tag);
    const box = make('section'), label = make('strong'), bar = make('progress'), hint = make('p'), actions = make('footer');
    box.lang = 'ja';
    box.setAttribute('aria-label', '動画ダウンロード');
    bar.max = 1; bar.setAttribute('aria-label', 'ダウンロード進捗');
    function button(text, action) {
      const el = make('button');
      el.type = 'button'; el.textContent = text;
      el.onclick = async event => {
        if (!event.isTrusted || closed || location.href !== originalUrl || releaseIfDisconnected()) return;
        try {
          const reply = await chrome.runtime.sendMessage({op:'source-action', id, run, action});
          if (!closed && reply?.error) hint.textContent = reply.error;
        } catch {
          if (!closed && !releaseIfDisconnected()) hint.textContent = '映蔵と通信できませんでした。もう一度お試しください。';
        }
      };
      actions.append(el);
      return el;
    }
    const save = button('保存', 'save'), stop = button('取得を停止', 'stop');
    const rescan = button('配信を再検出', 'rescan');
    const retry = button('再取得', 'retry');
    const skip = button('欠損区間をスキップして再取得', 'skip-gaps');
    button('キューを開く', 'open').className = 'open';
    save.className = 'primary';
    box.append(label, actions, bar, hint); root.append(box);
    function sourceTitle() {
      const title = document.title, oldPrefix = tabCaption && tabCaption + ' · ';
      if (title === appliedTitle) return originalTitle;
      return oldPrefix && title.startsWith(oldPrefix) ? title.slice(oldPrefix.length) : title;
    }
    function showTitle(caption) {
      originalTitle = sourceTitle();
      tabCaption = caption;
      appliedTitle = caption + ' · ' + originalTitle;
      if (document.title !== appliedTitle) document.title = appliedTitle;
    }
    let titleHead;
    const titleChanges = new MutationObserver(() => {
      if (document.head !== titleHead) watchTitle();
      if (tabCaption && document.title !== appliedTitle) {
        titleTimer ??= setTimeout(() => { titleTimer = undefined; showTitle(tabCaption); }, 150);
      }
    });
    function watchTitle() {
      titleHead = document.head;
      titleChanges.disconnect();
      titleChanges.observe(document.documentElement, {childList:true});
      if (titleHead) titleChanges.observe(titleHead, {subtree:true,childList:true,characterData:true});
    }
    watchTitle();
    function restoreTitle() {
      titleChanges.disconnect();
      clearTimeout(titleTimer);
      if (appliedTitle !== undefined && document.title === appliedTitle) document.title = originalTitle;
      appliedTitle = undefined;
    }
    function cleanup() {
      if (closed) return;
      closed = true;
      host.remove();
      tabIndicator.close();
      restoreTitle();
      document.removeEventListener(checkPanel, releaseIfDisconnected);
      removeEventListener('focus', releaseIfDisconnected);
      removeEventListener('pagehide', end);
      removeEventListener('hashchange', checkUrl);
      removeEventListener('popstate', checkUrl);
      window.navigation?.removeEventListener('currententrychange', checkUrl);
      if (active?.run === run) active = null;
    }
    function releaseIfDisconnected() {
      try {
        if (globalThis.chrome?.runtime?.getURL('')) return false;
      } catch { /* Chrome can invalidate the API while the old document remains open. */ }
      cleanup();
      return true;
    }
    function end() { cleanup(); }
    function checkUrl() { if (location.href !== originalUrl) end(); }
    document.addEventListener(checkPanel, releaseIfDisconnected);
    addEventListener('focus', releaseIfDisconnected);
    addEventListener('pagehide', end, { once: true });
    addEventListener('hashchange', checkUrl);
    addEventListener('popstate', checkUrl);
    window.navigation?.addEventListener('currententrychange', checkUrl);
    function render(view) {
      if (terminalPhase && view.phase !== terminalPhase) return;
      if (view.phase === 'saved' || view.phase === 'mergeFailed') terminalPhase = view.phase;
      if (view.phase === 'saved' || view.phase === 'canceled') {
        host.remove();
      } else {
        if (!host.isConnected) document.documentElement.append(host);
        const needsPermission = view.phase === 'ready' && view.folderPermission;
        box.dataset.phase = needsPermission || view.saveStage === 'choosing' ? 'permission' : view.phase;
        hint.textContent = view.hint;
        bar.hidden = !['fetching','saving'].includes(view.phase) || view.saveStage === 'choosing';
        if (Number.isFinite(view.progress)) bar.value = view.progress; else bar.removeAttribute('value');
        save.hidden = view.phase !== 'ready' || view.folderPermission;
        retry.hidden = !['failed','interrupted'].includes(view.phase);
        skip.hidden = view.phase !== 'failed' || !view.canSkip;
        rescan.hidden = retry.hidden || !view.sourceProblem;
        stop.hidden = view.phase !== 'fetching' || !view.live;
      }
      tabIndicator.show(view, override => {
        const caption = override && view.phase === 'fetching' ? view.caption.replace(/^DL中/, override) : override || view.caption;
        label.textContent = caption;
        showTitle(caption);
      });
    }
    return {run, started:view.started, render, cleanup, get title() { return sourceTitle(); }};
  }
  chrome.runtime.onMessage.addListener((view,sender) => {
    if (view?.op !== 'source-view' || sender.id !== chrome.runtime.id || sender.tab ||
        (sender.url && sender.url !== chrome.runtime.getURL('background.mjs')) || view.url !== location.href) return;
    if (['saved','canceled'].includes(view.phase) && active?.run !== view.run) return;
    if (active?.run !== view.run) {
      if (active && active.started > view.started) return;
      active?.cleanup();
      active = mount(view);
    }
    active.render(view);
  });
  return location.href;
})();
