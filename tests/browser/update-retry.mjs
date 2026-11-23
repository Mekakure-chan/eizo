import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function suspendBackground(context,index,base,until) {
  const cdp=await context.newCDPSession(index);
  let version;
  cdp.on('ServiceWorker.workerVersionUpdated',({versions}) => {
    for (const item of versions) if (item.scriptURL === base+'/background.mjs') version=item;
  });
  try {
    await cdp.send('ServiceWorker.enable');
    await until(() => version?.runningStatus === 'running','test service worker active');
    await cdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});
    await until(() => version?.runningStatus === 'stopped','test service worker suspended');
  } finally {await cdp.detach();}
}

export async function testUpdateRetry({context,base,top,cdn,extension,worker,requests,releases,until,startFromToolbar,panelView,managerCount}) {
  const index = await context.newPage(), sources = [], ids = [];
  const broken = "import { RemovedByUpdate } from './mp4.mjs';\n";
  const pair = path.join(extension,'paired-mp4.mjs'), gap = path.join(extension,'gapped-mp4.mjs');
  const engine = path.join(extension,'engine.mjs');
  const [pairCode,gapCode,engineCode] = await Promise.all([pair,gap,engine].map(file=>readFile(file,'utf8')));
  const offscreen = () => index.evaluate(async () =>
    (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).map(c => c.documentId));
  const state = job => index.evaluate(async id => (await (await import('./queue.mjs')).readEntry(id)).state,job.id);
  const phase = (job,value) => until(async () => (await state(job))?.phase === value,job.name+' '+value);
  const manifestRequests = scenario => requests.filter(r => r.scenario === scenario &&
    (r.kind === 'playlist.m3u8' || (scenario === 'retrygap' && r.leaf === 'video.m3u8'))).length;
  let releaseDownload;
  releases.set('retry-held',new Promise(resolve => {releaseDownload=resolve;}));
  async function start(name,kind,url) {
    const source = await context.newPage(); sources.push(source);
    await source.goto(top+'/file-watch?case='+name);
    const result = await index.evaluate(async ({name,kind,url,sourceUrl}) => {
      const {pageId,readEntry} = await import('./queue.mjs'), {openTransfer} = await import('./jobs.mjs');
      const [tab] = await chrome.tabs.query({url:sourceUrl});
      const doc = await chrome.webNavigation.getFrame({tabId:tab.id,frameId:0});
      await openTransfer({kind,url,label:name,sourceTitle:name,sourceUrl,sourceDoc:doc.documentId,tabId:tab.id});
      const id = await pageId(sourceUrl);
      return {id,run:(await readEntry(id)).page.run,tabId:tab.id};
    },{name,kind,url,sourceUrl:source.url()});
    ids.push(result.id);
    return {name,source,...result};
  }
  try {
    await index.goto(base+'/manager.html');
    const managers = managerCount();
    await until(async () => !(await offscreen()).length,'cold test engine');
    await index.evaluate(async () => {
      window.retryLog=[]; window.retryGates={};
      chrome.storage.onChanged.addListener((changes,area) => {
        if (area !== 'session') return;
        for (const [key,{oldValue,newValue}] of Object.entries(changes)) {
          if (key.startsWith('download-state:') && newValue && newValue.phase !== oldValue?.phase)
            retryLog.push({run:newValue.run,phase:newValue.phase});
        }
      });
      for (const [key,name] of [['slot','embedded-video-saver/export/0'],['commit','fixture-commit/parallel-export-update-blocker.mp4']]) {
        await new Promise(held => { void navigator.locks.request(name,() => new Promise(release => {
          retryGates[key]=release; held();
        })); });
      }
    });
    // A real ESM linker failure is cached in the original engine. Repair only the paired converter on disk.
    await writeFile(pair,broken+pairCode); await writeFile(gap,broken+gapCode);
    const other = await start('parallel-export-update-blocker','file',top+'/clip.mp4?variant=retry-held');
    await phase(other,'fetching');
    const [oldEngine] = await offscreen();
    const success = await start('update-pair','hls',cdn+'/retrypair/playlist.m3u8');
    await phase(success,'updateRetry');
    const repeat = await start('update-gap','hls',cdn+'/retrygap/1080p/video.m3u8');
    await phase(repeat,'updateRetry');
    assert.equal(manifestRequests('retrypair'),1); assert.equal(manifestRequests('retrygap'),1);
    const row = index.locator('li[data-id="'+success.id+'"]');
    assert.equal(await row.locator('.phase').textContent(),'自動再取得待ち');
    await until(async () => (await panelView(success.tabId))?.label === '自動再取得待ち','source waiting label');
    await startFromToolbar(success.source,success.tabId);
    await until(() => worker.evaluate(async () => !(await chrome.runtime.getContexts({contextTypes:['POPUP']})).length),'repeated toolbar click');
    assert.equal((await state(success)).run,success.run);
    // Old-format errors are adopted in place and a user can cancel one without creating a queue tab.
    const legacy = await index.evaluate(async ({top}) => {
      const {pageId,pagePrefix,statusPrefix} = await import('./queue.mjs');
      const sourceUrl=top+'/legacy-update', id=await pageId(sourceUrl), run=crypto.randomUUID();
      await chrome.storage.session.set({[pagePrefix+id]:{id,run,sourceUrl,title:'legacy-update',incognito:false,
        started:Date.now(),runner:'tab',job:{kind:'file',url:top+'/clip.mp4'}},[statusPrefix+id]:{
        run,phase:'failed',text:"The requested module './mp4.mjs' does not provide an export named 'Mp4MergeError'"}});
      return {id,run,name:'legacy-update'};
    },{top});
    ids.push(legacy.id);
    await phase(legacy,'updateRetry');
    await index.locator('li[data-id="'+legacy.id+'"]').getByRole('button',{name:'中止',exact:true}).click();
    await phase(legacy,'canceled');
    await writeFile(pair,pairCode);
    await suspendBackground(context,index,base,until);
    releaseDownload();
    await phase(other,'saveQueued');
    assert.equal((await state(success)).phase,'updateRetry');
    await index.evaluate(() => retryGates.slot());
    await until(async () => (await state(other)).saveStage === 'committing','storage commit in progress');
    assert.equal((await state(repeat)).phase,'updateRetry');
    assert.deepEqual(await offscreen(),[oldEngine]);
    await index.evaluate(() => retryGates.commit());
    await phase(other,'saved'); await phase(success,'saved'); await phase(repeat,'failed');
    assert.match((await state(repeat)).text,/自動再取得.*1回/);
    await until(async () => !(await offscreen()).length,'retry engine to finish all work');
    assert.equal(manifestRequests('retrypair'),2); assert.equal(manifestRequests('retrygap'),2);
    const log = await index.evaluate(() => retryLog);
    const position = (job,phase,last=false) => last ? log.findLastIndex(e=>e.run===job.run && e.phase===phase) :
      log.findIndex(e=>e.run===job.run && e.phase===phase);
    assert.ok(position(success,'fetching',true) > position(other,'saved'));
    assert.ok(position(repeat,'fetching',true) > position(success,'saved'));
    assert.equal(log.filter(e=>e.run===repeat.run && e.phase==='fetching').length,2);
    assert.equal(log.filter(e=>e.run===legacy.run && e.phase==='fetching').length,0);
    assert.equal(managerCount(),managers);
    const saved = await index.evaluate(async () => {
      const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('更新再取得');
      const names=[]; for await (const name of dir.keys()) names.push(name);
      const file=await (await dir.getFileHandle('update-pair.mp4')).getFile();
      const {Input,MP4,BlobSource,EncodedPacketSink}=await import('./vendor/mediabunny-1.66.2.mjs');
      const input=new Input({formats:[MP4],source:new BlobSource(file)});
      try {
        const readable=async track => !!track && (await new EncodedPacketSink(track).getFirstPacket()).data.byteLength>0;
        return {names:names.sort(),video:await readable(await input.getPrimaryVideoTrack()),audio:await readable(await input.getPrimaryAudioTrack())};
      } finally {input.dispose();}
    });
    assert.deepEqual(saved,{names:['parallel-export-update-blocker.mp4','update-pair.mp4'],video:true,audio:true});
    // An old tab can report the raw error after a worker restart. The spent budget must still win.
    await suspendBackground(context,index,base,until);
    await index.evaluate(async ({id,run}) => chrome.storage.session.set({['download-state:'+id]:{
      run,phase:'failed',text:"The requested module './mp4.mjs' does not provide an export named 'Mp4MergeError'"}}),
      {id:repeat.id,run:repeat.run});
    await until(async () => (await state(repeat)).text.includes('自動再取得を1回'),'spent retry after second worker restart');
    assert.equal(manifestRequests('retrygap'),2);
    const restored = await index.evaluate(async top => {
      const {pageId,pagePrefix,statusPrefix}=await import('./queue.mjs'), rows={}, jobs=[];
      for (const [name,phase,runner] of [['orphan','fetching','engine'],['manual-save','ready','tab'],['old-queue','failed','tab'],
        ['unopened-queue','queued','tab']]) {
        const sourceUrl=top+'/'+name, id=await pageId(sourceUrl), run=crypto.randomUUID();
        rows[pagePrefix+id]={id,run,sourceUrl,title:name,incognito:false,started:Date.now(),runner,
          job:{kind:'file',url:top+'/clip.mp4',label:name}};
        rows[statusPrefix+id]={run,phase,...(phase==='ready' ? {output:{extension:'mp4',bytes:123}} :
          phase==='failed' ? {text:"The requested module './mp4.mjs' does not provide an export named 'Mp4MergeError'"} : {})};
        jobs.push({id,run,name});
      }
      await chrome.storage.session.set(rows); return jobs;
    },top);
    ids.push(...restored.map(job=>job.id));
    await phase(restored[0],'interrupted'); await phase(restored[3],'interrupted'); await phase(restored[2],'saved');
    assert.equal((await state(restored[1])).phase,'ready');
    assert.equal(managerCount(),managers);
    if (process.env.HLS_TEST_OLD_ENGINE) {
      await until(async () => !(await offscreen()).length,'cold engine for an incomplete installation');
      await writeFile(engine,await readFile(process.env.HLS_TEST_OLD_ENGINE));
      await index.evaluate(({id,run}) => chrome.storage.session.set({['download-state:'+id]:{run,phase:'failed',
        text:"The requested module './mp4.mjs' does not provide an export named 'Mp4MergeError'"}}),restored[0]);
      await until(async () => (await state(restored[0])).text?.includes('自動再取得を開始できませんでした'),'older engine to return a terminal result');
      await until(async () => !(await offscreen()).length,'older engine to retire');
      assert.equal((await state(restored[0])).phase,'failed');
    }
    console.log('update retry survived worker restarts, waited through download, save queue and disk commit, then retried two cached link errors once in order; one playable MP4 and one terminal error');
  } finally {
    releaseDownload(); releases.delete('retry-held');
    await index.evaluate(() => Object.values(window.retryGates || {}).forEach(release=>release())).catch(()=>{});
    await writeFile(pair,pairCode); await writeFile(gap,gapCode); await writeFile(engine,engineCode);
    await index.evaluate(ids => chrome.storage.session.remove(ids.flatMap(id=>['download-page:'+id,'download-state:'+id])),ids).catch(()=>{});
    await Promise.all([...sources,index].map(page=>page.close()));
  }
}
