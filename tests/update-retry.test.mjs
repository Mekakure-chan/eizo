import assert from 'node:assert/strict';
import test from 'node:test';
import {isUpdateModuleError, blocksUpdateRetry} from '../extension/update-retry.mjs';
import {finishFolderCheck, keepsPlace, phaseLabel, pagePrefix, statusPrefix, readEntry, writeState, reconcileUpdateFailure} from '../extension/queue.mjs';

const mismatch = "The requested module './mp4.mjs' does not provide an export named 'Mp4MergeError'";
test('only packaged module failures qualify and only work in flight delays a retry', () => {
  assert.ok(isUpdateModuleError(mismatch));
  const base = 'chrome-extension://fixture/';
  assert.ok(isUpdateModuleError(mismatch.replace('./mp4.mjs',base+'mp4.mjs'),base));
  assert.ok(isUpdateModuleError('Failed to fetch dynamically imported module: '+base+'paired-mp4.mjs',base));
  assert.ok(isUpdateModuleError(mismatch.replace('./mp4.mjs','./mp4-duration.mjs')));
  assert.ok(isUpdateModuleError('Failed to fetch dynamically imported module: '+base+'mp4-duration.mjs',base));
  assert.ok(isUpdateModuleError('Failed to fetch dynamically imported module: '+base+'mp4-track-time.mjs',base));
  for (const error of ['HTTP 403','Failed to fetch','QuotaExceededError', 'The extension context was invalidated.',
    mismatch.replace('./mp4.mjs','https://example.test/mp4.mjs'), 'Failed to fetch dynamically imported module: https://example.test/mp4.mjs',
    'Failed to fetch dynamically imported module: chrome-extension://another/paired-mp4.mjs']) assert.ok(!isUpdateModuleError(error,base),error);
  for (const phase of ['queued','fetching','recording','saveQueued','saving']) assert.ok(blocksUpdateRetry(phase),phase);
  for (const phase of ['updateRetry','ready','saved','permission','setup','canceled','failed','mergeFailed']) assert.ok(!blocksUpdateRetry(phase),phase);
  assert.ok(keepsPlace('updateRetry'));
  assert.equal(phaseLabel({phase:'updateRetry'}),'自動再取得待ち');
  assert.ok(blocksUpdateRetry('ready',true));
});

test('only a fresh download is owed a folder lookup, and an older lookup cannot rewind a canceled save', async () => {
  const id='clip', run='run', pk=pagePrefix+id, sk=statusPrefix+id;
  const rows={[pk]:{id,run,incognito:false,job:{kind:'file'}},[sk]:{run,phase:'fetching'}};
  globalThis.chrome={storage:{session:{
    async get(keys){return structuredClone(Object.fromEntries(keys.map(k=>[k,rows[k]])));},
    async set(values){Object.assign(rows,structuredClone(values));}
  }}};
  try {
    const ready={phase:'ready',text:'取得済み',output:{extension:'mp4',bytes:10}};
    await writeState(id,run,ready,'fetching');
    const completed=rows[sk];
    assert.equal(completed.folderSavePending,true);
    await writeState(id,run,{...completed,phase:'saveQueued'},'ready');
    assert.equal(rows[sk].folderSavePending,undefined);
    await writeState(id,run,{...completed,text:'保存をキャンセルしました。'},'saveQueued');
    assert.equal(rows[sk].folderSavePending,undefined);
    assert.ok(!await finishFolderCheck(id,run,completed,'以前の保存先エラー'));
    assert.equal(rows[sk].text,'保存をキャンセルしました。');
    rows[sk]={run,phase:'recording'};
    await writeState(id,run,ready,'recording');
    assert.ok(await finishFolderCheck(id,run,rows[sk]));
    assert.deepEqual(rows[sk],{...ready,run});
  } finally {delete globalThis.chrome;}
});

test('retry budget belongs to one run and survives progress, concurrent claims and legacy queue recovery', async () => {
  const id='item', run='first', pk=pagePrefix+id, sk=statusPrefix+id;
  const page={id,run,incognito:false,runner:'tab',job:{kind:'hls'}}, failure={run,phase:'failed',text:mismatch};
  const rows={[pk]:page,[sk]:failure};
  globalThis.chrome={storage:{session:{
    async get(keys){return structuredClone(keys===null ? rows : Object.fromEntries(keys.map(k=>[k,rows[k]])));},
    async set(values){Object.assign(rows,structuredClone(values));}
  }}};
  try {
    assert.ok(!await reconcileUpdateFailure(id,run,true));
    assert.ok(!await reconcileUpdateFailure(id,'stale',false));
    assert.equal((await Promise.all([reconcileUpdateFailure(id,run,false),reconcileUpdateFailure(id,run,false)])).filter(Boolean).length,1);
    assert.equal(rows[pk].runner,'engine'); assert.equal(rows[sk].phase,'updateRetry');
    // A duplicate failure or late progress report from the old attempt is not a retry.
    await Promise.all([writeState(id,run,failure),writeState(id,run,{phase:'fetching',progress:0.8})]);
    assert.equal(rows[sk].phase,'updateRetry','stale reports consumed an unstarted retry');
    assert.equal(rows[pk].updateRetry,undefined);
    assert.equal((await Promise.all([writeState(id,run,{phase:'fetching'},'updateRetry'),writeState(id,run,{phase:'fetching'},'updateRetry')])).filter(Boolean).length,1);
    await writeState(id,run,{phase:'fetching',progress:0.5});
    await writeState(id,run,failure);
    assert.equal((await readEntry(id)).state.phase,'failed');
    assert.match(rows[sk].text,/自動再取得.*1回/);
    assert.ok(!await reconcileUpdateFailure(id,run,false));
    for (const state of [{phase:'ready',output:{bytes:7},text:mismatch},{phase:'failed',text:'HTTP 403'},{phase:'mergeFailed',text:mismatch}]) {
      rows[pk]=page; await writeState(id,run,state); assert.deepEqual(rows[sk],{...state,run});
    }
    rows[pk]={...page,run:'new'}; await writeState(id,'new',failure);
    assert.equal(rows[sk].phase,'updateRetry');
    assert.ok(await writeState(id,'new',{phase:'canceled'},'updateRetry'));
    assert.ok(!await writeState(id,'new',{phase:'fetching'},'updateRetry'));
    assert.equal(rows[sk].phase,'canceled');
    rows[sk]={...failure,run:'new'}; await reconcileUpdateFailure(id,'new',false);
    assert.equal(rows[sk].phase,'canceled','a late old tab must not re-arm a canceled retry');
    await writeState(id,'new',{phase:'fetching'},'canceled'); await writeState(id,'new',failure);
    assert.equal(rows[sk].phase,'updateRetry','explicitly restarting a canceled job still has one unused attempt');
  } finally {delete globalThis.chrome;}
});
