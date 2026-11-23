import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {suspendBackground} from './update-retry.mjs';

const mismatch = "The requested module './mp4.mjs' does not provide an export named 'Mp4MergeError'";
const brokenImport = "import { MissingAfterUpdate } from './mp4.mjs';\n";

export async function testRetryRecovery({mode,context,base,top,cdn,extension,worker,requests,releases,until}) {
  const index=await context.newPage(), sources=[], ids=[];
  const script=path.join(extension,mode==='retrychoice'?'gapped-mp4.mjs':'engine.mjs');
  const original=await readFile(script,'utf8');
  const entry=id=>index.evaluate(async id=>(await import('./queue.mjs')).readEntry(id),id);
  const phase=(id,wanted,ms)=>until(async()=>(await entry(id)).state?.phase===wanted,mode+' '+wanted,ms);
  const engineGone=()=>until(()=>index.evaluate(async()=>!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length),'offscreen document closing');
  let release;
  async function inline(name,kind,url) {
    const source=await context.newPage(); sources.push(source);
    await source.goto(top+'/file-watch?case='+name);
    const id=await index.evaluate(async ({sourceUrl,name,kind,url})=>{
      const [tab]=await chrome.tabs.query({url:sourceUrl});
      const doc=await chrome.webNavigation.getFrame({tabId:tab.id,frameId:0});
      await (await import('./jobs.mjs')).openTransfer({kind,url,label:name,sourceTitle:name,sourceUrl,sourceDoc:doc.documentId,tabId:tab.id});
      return (await import('./queue.mjs')).pageId(sourceUrl);
    },{sourceUrl:source.url(),name,kind,url});
    ids.push(id); return id;
  }
  async function oldFailures(names) {
    const added=await index.evaluate(async({top,names,mismatch})=>{
      const {pageId,pagePrefix,statusPrefix}=await import('./queue.mjs');
      const updates={}, ids=[];
      for(const name of names) {
        const sourceUrl=top+'/'+name,id=await pageId(sourceUrl),run=crypto.randomUUID();
        updates[pagePrefix+id]={id,run,sourceUrl,title:name,runner:'engine',incognito:false,started:Date.now(),job:{kind:'file',label:name,url:top+'/clip.mp4'}};
        updates[statusPrefix+id]={run,phase:'failed',text:mismatch};
        ids.push(id);
      }
      await chrome.storage.session.set(updates); return ids;
    },{top,names,mismatch});
    ids.push(...added); return added;
  }
  try {
    await index.goto(base+'/manager.html'); await engineGone();
    if (mode==='retryengine') {
      // The document exists but its module failed to link, so nobody can answer an idle query.
      await writeFile(script,brokenImport+original);
      await worker.evaluate(()=>chrome.offscreen.createDocument({url:'engine.html',reasons:['BLOBS'],justification:'Local startup failure test'}));
      assert.equal(await worker.evaluate(async()=>!!(await chrome.runtime.sendMessage({destination:'hls-engine',action:'idle?'}).catch(()=>null))),false);
      await writeFile(script,original);
      const [fixed]=await oldFailures(['fixed-engine']);
      await phase(fixed,'saved',5000);
      await engineGone();
      // If the new copy still cannot load, each job must end and release the empty document.
      await writeFile(script,brokenImport+original);
      const failed=await oldFailures(['bad-engine-1','bad-engine-2']);
      for (const id of failed) {
        await until(async()=>{const {page,state}=await entry(id);return page.updateRetry==='used' && state.phase==='failed';},'failed engine exhausted once');
      }
      await engineGone();
      console.log('a previously unresponsive engine recovered from repaired files; a still-broken engine ended both attempts and closed');
    } else if (mode==='retrychoice') {
      await index.evaluate(()=>chrome.storage.local.set({'hls-auto-skip-gaps:normal':false}));
      releases.set('retry-held',new Promise(resolve=>{release=resolve;}));
      await inline('choice-blocker','file',top+'/clip.mp4?variant=retry-held');
      await writeFile(script,brokenImport+original);
      const id=await inline('update-skip-choice','hls',cdn+'/retrychoice/1080p/video.m3u8');
      await phase(id,'failed');
      const before=requests.filter(r=>r.scenario==='retrychoice' && r.leaf==='1.m4s').length;
      assert.ok(before>0 && (await entry(id)).state.canSkip);
      await index.locator('li[data-id="'+id+'"]').getByRole('button',{name:'欠損区間をスキップして再取得'}).click();
      await phase(id,'updateRetry'); await writeFile(script,original); release();
      await until(async()=>{const {page,state}=await entry(id);return page.updateRetry==='used' && ['failed','saved'].includes(state.phase);},'automatic retry following an explicit skip');
      const result=(await entry(id)).state;
      assert.equal(result.phase,'saved',result.text);
      assert.equal(result.omittedRanges?.length,1);
      assert.equal(requests.filter(r=>r.scenario==='retrychoice' && r.leaf==='1.m4s').length,before);
      console.log('the update retry retained the explicit skip and saved the remaining media without requesting the known missing segment again');
    } else if (mode==='retryadmission') {
      releases.set('retry-held',new Promise(resolve=>{release=resolve;}));
      const id=await index.evaluate(async top=>{
        const {pageId,pagePrefix,statusPrefix}=await import('./queue.mjs');
        const sourceUrl=top+'/delayed-claim', id=await pageId(sourceUrl), run=crypto.randomUUID();
        await new Promise(held=>{void navigator.locks.request('embedded-video-queue/'+id,()=>new Promise(release=>{
          window.releaseClaim=release; held();
        }));});
        await chrome.storage.session.set({[pagePrefix+id]:{id,run,sourceUrl,title:'delayed-claim',runner:'engine',incognito:false,
          started:Date.now(),job:{kind:'file',label:'delayed-claim',url:top+'/clip.mp4'}},[statusPrefix+id]:{run,phase:'updateRetry'}});
        return id;
      },top);
      ids.push(id);
      await until(()=>index.evaluate(async id=>(await navigator.locks.query()).pending.some(lock=>lock.name==='embedded-video-queue/'+id),id),'dispatched retry waiting to claim its job');
      const other=await inline('concurrent-start','file',top+'/clip.mp4?variant=retry-held');
      await phase(other,'fetching');
      await index.evaluate(async id=>{
        releaseClaim(); await navigator.locks.request('embedded-video-queue/'+id,()=>{});
      },id);
      const waiting=await entry(id);
      assert.equal(waiting.state.phase,'updateRetry','a newly started download must take priority at the actual retry claim');
      assert.equal(waiting.page.updateRetry,undefined);
      release(); await phase(other,'saved'); await phase(id,'saved');
      console.log('a new normal download took priority between retry dispatch and acquisition without consuming the waiting attempt');
    } else if (mode==='retrycancelsave') {
      await index.evaluate(()=>new Promise(held=>{
        void navigator.locks.request('embedded-video-saver/export/0',()=>new Promise(release=>{
          window.releaseSlot=release; held();
        }));
      }));
      // Delay only the first automatic lookup. The user's explicit save and cancel still run normally.
      await worker.evaluate(()=>{
        const open=indexedDB.open.bind(indexedDB);
        indexedDB.open=(name,...args)=>{
          const request=open(name,...args);
          if(name!=='embedded-video-saver-preferences')return request;
          indexedDB.open=open;
          const delayed={get result(){return request.result;},get error(){return request.error;}};
          request.onsuccess=()=>{self.resumeFolderLookup=()=>delayed.onsuccess();};
          request.onerror=()=>delayed.onerror();
          return delayed;
        };
      });
      const id=await inline('cancel-during-folder-check','file',top+'/clip.mp4');
      await phase(id,'ready');
      await until(()=>worker.evaluate(()=>!!self.resumeFolderLookup),'deferred automatic folder lookup');
      const row=index.locator('li[data-id="'+id+'"]');
      await row.getByRole('button',{name:'保存',exact:true}).click();
      await phase(id,'saveQueued'); await row.getByRole('button',{name:'保存を中止'}).click();
      await phase(id,'ready');
      assert.match((await entry(id)).state.text,/キャンセル/);
      const [retry]=await oldFailures(['after-save-canceled']); await phase(retry,'updateRetry');
      await index.evaluate(()=>releaseSlot()); await worker.evaluate(()=>resumeFolderLookup());
      await phase(retry,'saved');
      assert.equal((await entry(id)).state.phase,'ready','a late automatic folder lookup must not undo cancel');
      const names=await index.evaluate(async()=>{
        const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('再取得検証');
        const names=[]; for await(const name of dir.keys())names.push(name); return names;
      });
      assert.ok(!names.includes('cancel-during-folder-check.mp4'));
      console.log('a save canceled during a delayed automatic folder lookup remained ready while the next retry saved');
    } else {
      // Suspend the worker after the download reached ready but before it can enqueue its folder export.
      await worker.evaluate(()=>{
        const open=indexedDB.open.bind(indexedDB);
        indexedDB.open=(name,...args)=>{
          if(name==='embedded-video-saver-preferences'){self.fixtureFolderRead=true;return new EventTarget();}
          return open(name,...args);
        };
      });
      const other=await inline('save-handoff','file',top+'/clip.mp4');
      await phase(other,'ready'); await until(()=>worker.evaluate(()=>self.fixtureFolderRead),'folder lookup in progress');
      const [retry]=await oldFailures(['after-handoff']); await phase(retry,'updateRetry');
      await index.evaluate(({other,retry})=>{
        window.retryOrder=[];
        chrome.storage.onChanged.addListener((changes,area)=>{
          if(area!=='session')return;
          for(const [key,c] of Object.entries(changes)) {
            if(key==='download-state:'+other && c.newValue?.phase==='saved') retryOrder.push('saved');
            if(key==='download-state:'+retry && c.newValue?.phase==='fetching' && c.oldValue?.phase!=='fetching') retryOrder.push('retry');
          }
        });
      },{other,retry});
      await suspendBackground(context,index,base,until);
      await index.evaluate(()=>chrome.runtime.sendMessage({op:'detected',tabId:0}));
      await phase(retry,'saved');
      assert.equal((await entry(other)).state.phase,'saved','the worker restart stranded the pre-existing automatic save');
      assert.deepEqual(await index.evaluate(()=>retryOrder),['saved','retry']);
      console.log('worker suspension during the folder lookup preserved automatic saving and deferred the waiting retry until the file was committed');
    }
  } finally {
    release?.(); if(release) releases.delete('retry-held');
    await writeFile(script,original);
    await index.evaluate(async ids=>{
      await chrome.storage.local.remove('hls-auto-skip-gaps:normal');
      await chrome.storage.session.remove(ids.flatMap(id=>['download-page:'+id,'download-state:'+id]));
    },ids).catch(()=>{});
    await Promise.all([...sources,index].map(p=>p.close()));
  }
}
