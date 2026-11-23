import { element } from './media.mjs';
import { mp4StatusText } from './mp4-merge-error.mjs';
import { needsSourceTab, omissionText, phaseLabel, sourceDocument } from './queue.mjs';
import { recordFormats } from './recording.mjs';

export function queueGroup(state) {
  const phase = state.phase;
  if (phase === 'saved') return 'saved';
  if (['failed','mergeFailed','interrupted','canceled'].includes(phase)) return 'stopped';
  if ((phase === 'saveQueued' || phase === 'saving') && state.saveStage === 'choosing') return 'attention';
  if (['queued','updateRetry','saveQueued'].includes(phase)) return 'queued';
  if (['fetching','recording','saving'].includes(phase)) return 'active';
  return 'attention';
}

function actionsFor(page, state, folder) {
  const actions = [], phase = state.phase;
  const add = (name, label, primary = false) => actions.push({name,label,primary});
  if (phase === 'ready') {
    add('save', folder && state.folderPermission ? '許可して保存' : '保存', true);
    if (state.output?.raw) add('raw','元のTSを保存');
    add('discard','破棄');
  } else if (phase === 'fetching' || phase === 'recording') {
    if (phase === 'recording' || state.live) add('stop', phase === 'recording' ? '録画を停止' : '取得を停止', true);
    add('cancel','中止');
  } else if (phase === 'updateRetry') {
    add('cancel','中止');
  } else if (phase === 'saveQueued' || (phase === 'saving' && state.saveStage !== 'committing')) {
    add('cancel','保存を中止');
  } else if (phase === 'permission') {
    add('grant','許可して取得',true); add('cancel','中止');
  } else if (phase === 'setup') {
    add('format','録画形式'); add('record','録画を開始',true); add('cancel','中止');
  } else if (['failed','interrupted','canceled','reader','method'].includes(phase)) {
    add('retry','再取得',true);
    if (phase === 'failed' && state.canSkip) add('skip-gaps','欠損区間をスキップして再取得');
    if (phase === 'reader' || phase === 'method') add('cancel','中止');
    if (state.sourceProblem && Number.isInteger(page.job.tabId)) add('rescan','元ページで再検出');
  }
  return actions;
}

// Keep controls mounted during progress updates, including a pending click or a selected recording format.
export function createQueueList(list, {link, meter, act}) {
  const rows = new Map(), sources = new Map(), neededDocs = new Map(), formats = recordFormats();
  let visible = [], all = [], folder = null;

  function readSource(tabId) {
    const pending = {};
    sources.set(tabId,pending);
    chrome.webNavigation.getFrame({tabId,frameId:0}).then(frame => {
      if (sources.get(tabId) !== pending) return;
      sources.set(tabId,frame || null); paint();
    }).catch(() => {
      if (sources.get(tabId) === pending) { sources.set(tabId,null); paint(); }
    });
  }
  function navigated(event) {
    if (event.frameId !== 0 || !sources.has(event.tabId)) return;
    sources.set(event.tabId,event); paint();
  }
  for (const event of [chrome.webNavigation.onCommitted, chrome.webNavigation.onHistoryStateUpdated, chrome.webNavigation.onReferenceFragmentUpdated]) {
    event.addListener(navigated);
  }
  function removed(tabId) {
    if (sources.has(tabId)) { sources.set(tabId,null); paint(); }
  }
  chrome.tabs.onRemoved.addListener(removed);
  chrome.tabs.onReplaced.addListener((_,old) => removed(old));

  function makeRow(id) {
    const row = element('li'), body = element('div','','row-body'), heading = element('h3','','row-title');
    const title = element('button','','row-detail'), source = element('a','','source-link');
    title.type = 'button'; title.title = '個別キューを表示';
    source.target = '_blank'; source.rel = 'noopener noreferrer';
    const detail = element('p','','row-note'), problem = element('p','','row-error');
    problem.hidden = true; problem.setAttribute('role','status');
    body.append(heading,source,detail,problem); heading.append(title);
    const status = element('div','','row-progress'), badge = element('span','','phase'), bar = element('progress');
    bar.max = 1; status.append(badge,bar);
    const controls = element('div','','row-actions'); controls.setAttribute('role','group');
    row.dataset.id = id; row.append(body,status,controls);
    const ui = {row,title,source,detail,problem,badge,bar,controls,buttons:new Map(),busy:new Set()};
    async function run(action) {
      if (ui.busy.has(action)) return;
      const entry = ui.entry;
      ui.busy.add(action); problem.hidden = true; paintRow(ui,entry,true);
      try { await act(action,entry,ui.buttons.get('format')?.value); }
      catch (error) {
        if (ui.entry.page.run === entry.page.run && error.name !== 'AbortError') {
          problem.textContent = error.message || String(error); problem.hidden = false;
        }
      } finally { ui.busy.delete(action); paintRow(ui,ui.entry,true); }
    }
    title.onclick = () => run('details');
    controls.onclick = event => {
      const btn = event.target.closest('button[data-action]');
      if (btn && !btn.disabled) void run(btn.dataset.action);
    };
    return ui;
  }

  function sourceAction(page) {
    const doc = sourceDocument(page), tabId = page.job.tabId;
    if (page.manual || !doc || !Number.isInteger(tabId)) return null;
    if (!sources.has(tabId)) readSource(tabId);
    const frame = sources.get(tabId);
    if (frame?.documentId !== doc || frame.url !== page.sourceUrl) return null;
    const needed = neededDocs.get(tabId);
    return needed?.has(doc) || needed?.has(null) ? 'needed' : 'available';
  }

  function paintRow(ui, entry, force = false) {
    const {page,state} = entry, phase = state.phase, old = ui.entry;
    const close = sourceAction(page), hasFolder = !!folder;
    if (!force && old?.page === page && old.state === state && ui.close === close && ui.hasFolder === hasFolder) return;
    ui.close = close; ui.hasFolder = hasFolder;
    if (old?.page.run !== page.run || old.state.phase !== phase) ui.problem.hidden = true;
    ui.entry = {page,state};
    if (old?.page !== page) {
      ui.title.textContent = page.title; link(ui.source,page);
      ui.bar.setAttribute('aria-label',page.title + ' の進捗');
      ui.controls.setAttribute('aria-label',page.title + ' の操作');
    }
    const moving = ['fetching','recording','saving'].includes(phase) && state.saveStage !== 'choosing';
    const value = Number.isFinite(state.progress) ? ' '+Math.round(state.progress*100)+'%' : state.progressDetail ? ' '+state.progressDetail : '';
    const permission = phase === 'ready' && state.folderPermission;
    ui.badge.textContent = permission ? '保存先の許可待ち' : phaseLabel(state) + (moving ? value : '');
    ui.badge.dataset.group = queueGroup(state);
    ui.badge.dataset.state = permission ? 'permission' : phase;
    ui.bar.hidden = !moving; if (moving) meter(ui.bar,state.progress);
    const explain = ['failed','mergeFailed','interrupted','permission','updateRetry'].includes(phase) ||
      phase === 'ready' && (permission || state.output?.interruption || /失敗|保存できません|キャンセル|中断/.test(state.text));
    let note = explain ? mp4StatusText(state) : '';
    if (!note && state.destinationName && ['saveQueued','saving','saved'].includes(phase)) note = '保存先 · ' + state.destinationName;
    if (!note && state.workerTab != null) note = 'この取得を再開した一覧タブを開いたままにしてください。';
    const actions = actionsFor(page,state,folder);
    if (close) {
      const needed = close === 'needed';
      if (needed && !note) note = '取得や録画に元タブを使用中です。';
      actions.push({name:'close-source',label:'元タブを閉じる',disabled:needed,
        hint:needed ? '取得や録画に元タブを使っています。' : ''});
    }
    if (phase === 'saving' && state.text) note = [state.text, note].filter(Boolean).join('　');
    const omitted = omissionText(state,2);
    if (omitted) note = [note, omitted].filter(Boolean).join('　');
    ui.detail.hidden = !note; if (note && ui.detail.textContent !== note) ui.detail.textContent = note;
    const keep = new Set(actions.map(a => a.name));
    for (const [name,control] of ui.buttons) if (!keep.has(name)) { control.remove(); ui.buttons.delete(name); }
    actions.forEach(({name,label,primary,disabled,hint},i) => {
      let control = ui.buttons.get(name);
      if (!control) {
        control = element(name === 'format' ? 'select' : 'button');
        if (name === 'format') {
          control.setAttribute('aria-label',label);
          for (const f of formats) control.add(new Option(f.toUpperCase(),f));
        } else { control.type = 'button'; control.dataset.action = name; }
        ui.buttons.set(name,control);
      }
      if (name !== 'format' && control.textContent !== label) control.textContent = label;
      control.className = primary ? '' : 'quiet'; control.title = hint || '';
      control.disabled = !!disabled || ui.busy.has(name) || (name === 'record' && !formats.length);
      if (ui.controls.children[i] !== control) ui.controls.insertBefore(control,ui.controls.children[i] || null);
    });
  }

  function paint() {
    neededDocs.clear();
    for (const {page,state} of all) {
      const tabId = page.job.tabId;
      if (!Number.isInteger(tabId) || !needsSourceTab(page,state)) continue;
      if (!neededDocs.has(tabId)) neededDocs.set(tabId,new Set());
      neededDocs.get(tabId).add(sourceDocument(page) || null);
    }
    const keep = new Set(visible.map(e => e.page.id));
    for (const [id,ui] of rows) if (!keep.has(id)) { ui.row.remove(); rows.delete(id); }
    visible.forEach((entry,i) => {
      const id = entry.page.id;
      if (!rows.has(id)) rows.set(id,makeRow(id));
      const ui = rows.get(id); paintRow(ui,entry);
      if (list.children[i] !== ui.row) list.insertBefore(ui.row,list.children[i] || null);
    });
  }
  return {
    render(entries,others,preferredFolder) {
      all = entries; visible = others; folder = preferredFolder; paint();
    },
    update(entry) {
      const ui = rows.get(entry.page.id);
      if (ui) paintRow(ui,entry);
    }
  };
}
