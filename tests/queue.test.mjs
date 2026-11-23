import assert from 'node:assert/strict';
import test from 'node:test';
import { detachedState, handleQueueRequest, keepsPlace, pageId, readEntry, recoverManagerState, writeState } from '../extension/queue.mjs';
import { mp4StatusText } from '../extension/mp4-merge-error.mjs';

test('an earlier module mismatch shows the available recovery action without changing the job', () => {
  const raw = "The requested module './mp4.mjs' does not provide an export named 'Mp4MergeError'";
  const failed = {phase:'failed', text:raw};
  assert.match(mp4StatusText(failed),/結合処理.*「再取得」/);
  assert.equal(failed.text,raw);
  assert.match(mp4StatusText({phase:'ready',text:'保存できませんでした。'+raw}),/もう一度保存/);
  for (const text of ['配信元が動画区間の取得を拒否しました（HTTP 403）。','結合に失敗しました。',undefined]) {
    assert.equal(mp4StatusText({phase:'failed',text}),text);
  }
});

test('the full original page selects its queue even when a media URL changes', async () => {
  const source = 'https://example.test/watch?v=one';
  assert.equal(await pageId(source), await pageId(source));
  for (const other of [pageId(source + '#another-route'), pageId(source.replace('one','two')), pageId(source, true), pageId(source, false, true)]) {
    assert.notEqual(await pageId(source), await other);
  }
  await assert.rejects(pageId('javascript:alert(1)'));
  await assert.rejects(pageId('https://name:password@example.test/'));
});

test('opening a page again preserves running work and the unsaved file', () => {
  for (const phase of ['queued','fetching','method','recording','permission','setup','ready','saveQueued','saving']) assert.ok(keepsPlace(phase));
  for (const phase of ['failed','saved','interrupted','canceled']) assert.ok(!keepsPlace(phase));
  const output = { extension: 'mp4', bytes: 32768 };
  const ready = { run: 'attempt', phase: 'ready', output };
  assert.equal(detachedState(ready), null);
  assert.equal(detachedState({...ready,phase:'saveQueued',backgroundSave:true}),null);
  assert.equal(detachedState({...ready,phase:'saveQueued'}).phase,'ready');
  assert.deepEqual(detachedState({ ...ready, phase: 'saving' }).output, output);
  assert.equal(detachedState({ ...ready, phase: 'saving' }).phase, 'ready');
  assert.equal(detachedState({ ...ready, phase: 'fetching' }).phase, 'interrupted');
  assert.equal(detachedState({ ...ready, phase: 'method' }).phase, 'interrupted');
});

test('one toolbar click can restart a background download found to have stopped', async () => {
  const sourceUrl = 'https://example.test/restart', id = await pageId(sourceUrl);
  const run = crypto.randomUUID(), page = {id,run,sourceUrl,incognito:false,runner:'engine'};
  const data = {['download-page:'+id]:page,['download-state:'+id]:{run,phase:'fetching'}};
  globalThis.chrome = {storage:{session:{
    get:async keys => Object.fromEntries(keys.map(key => [key,data[key]])),
    set:async patch => Object.assign(data,patch)
  }}};
  try {
    const presented = [];
    const handled = await handleQueueRequest({op:'queue-find',sourceUrl},{},{
      recover:async () => ({run,phase:'interrupted'}),
      present:(_page,state) => presented.push(state.phase)
    });
    assert.equal((await readEntry(id)).state.phase,'interrupted');
    assert.equal(handled,false,'the popup must continue detecting a fresh candidate on the same click');
    assert.deepEqual(presented,['interrupted'],'the source tab must stop displaying the previous download as active');
  } finally { delete globalThis.chrome; }
});

test('a returning queue tab cannot interrupt a job claimed elsewhere or a completed save', async () => {
  const id = await pageId('https://example.test/queue-owner'), run = crypto.randomUUID();
  const page = {id,run,owner:4,runner:'tab'}, state = {run,phase:'saving',output:{bytes:128}};
  const pk = 'download-page:'+id, sk = 'download-state:'+id, data = {};
  globalThis.chrome = {storage:{session:{
    get:async keys => Object.fromEntries(keys.map(key => [key,data[key]])),
    set:async patch => Object.assign(data,patch)
  }}};
  try {
    for (const [owner,active] of [
      [{...page,owner:5},state],[{...page,runner:'engine'},state],[page,{...state,phase:'saved'}],
      [page,{...state,workerTab:6}],[page,{...state,backgroundSave:true}]
    ]) {
      data[pk] = owner; data[sk] = active;
      assert.equal(await recoverManagerState(id,run,4,'saving'),false);
      assert.deepEqual(data[sk],active);
    }
    data[pk] = page; data[sk] = state;
    assert.equal((await recoverManagerState(id,run,4,'saving')).phase,'ready');
    assert.deepEqual(data[sk].output,state.output);
  } finally { delete globalThis.chrome; }
});

test('an already-open manager can still use the original cleanup exports during an update', async () => {
  const {managerClosed, recoverListWork} = await import('../extension/queue.mjs');
  globalThis.chrome = {storage:{session:{get:async () => ({})}}};
  try {
    await recoverListWork(5);
    await managerClosed(5);
  } finally { delete globalThis.chrome; }
});

test('racing new downloads create one manager even before Chrome exposes its URL, and stale writers cannot overwrite a new attempt', async () => {
  const storage = new Map(), tabs = new Map(), created = [];
  const source = { id: 7, incognito: false, windowId: 9 };
  tabs.set(7, source);
  globalThis.chrome = {
    storage: { session: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, storage.get(key)])); },
      async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value)); }
    } },
    runtime: { getURL: p => 'chrome-extension://test/' + p, getContexts: async () => [], sendMessage: async () => null },
    tabs: {
      get: async id => tabs.get(id),
      create: async ({ url }) => {
        const tab = { id: created.length + 20, windowId: 9, incognito: false, status: 'loading' };
        created.push(url); tabs.set(tab.id, tab); return tab;
      },
      update: async id => tabs.get(id)
    },
    windows: { update: async () => {} }
  };
  try {
    const sourceUrl = 'https://example.test/watch?video=7', id = await pageId(sourceUrl);
    const click = i => handleQueueRequest({ op: 'queue-add', sourceUrl, sourceTabId: 7,
      job: { kind: 'hls', url: 'https://media.test/' + i + '.m3u8' } }, {});
    await Promise.all(Array.from({length:12}, (_, i) => click(i)));
    assert.equal(created.length, 1);
    const { page } = await readEntry(id);
    await writeState(id, page.run, { phase: 'reader' });
    assert.equal(await handleQueueRequest({ op:'queue-find', sourceUrl, sourceTabId:7 }, {}), true);
    assert.equal((await readEntry(id)).page.run, page.run);
    assert.equal(detachedState({phase:'reader'}).phase, 'interrupted');
    await writeState(id, page.run, { phase: 'ready', output: { bytes: 8 } });
    await click(20);
    assert.equal((await readEntry(id)).page.run, page.run);
    await writeState(id, page.run, { phase: 'saved' });
    await click(22);
    assert.notEqual((await readEntry(id)).page.run, page.run);
    assert.equal(await writeState(id, page.run, { phase: 'failed' }), false);
    assert.equal((await readEntry(id)).state.phase, 'queued');
    const second = (await readEntry(id)).page;
    await writeState(id, second.run, { phase: 'reader' });
    await click(23);
    const refreshed = (await readEntry(id)).page;
    assert.notEqual(refreshed.run, second.run);
    assert.equal(refreshed.job.url, 'https://media.test/23.m3u8');
    assert.equal(created.length, 1);
  } finally { delete globalThis.chrome; }
});
