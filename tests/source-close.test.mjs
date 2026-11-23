import assert from 'node:assert/strict';
import test from 'node:test';
import { handleQueueRequest, pageId, pagePrefix, statusPrefix } from '../extension/queue.mjs';

test('close-source rechecks the run, dependencies, exact top document, tab and manager context', async () => {
  const url = 'https://example.test/watch#one', id = await pageId(url), run = 'first';
  const page = {id,run,sourceUrl:url,job:{kind:'hls',tabId:7,sourceDoc:'original'},incognito:false};
  const data = {[pagePrefix+id]:page,[statusPrefix+id]:{run,phase:'saving'}};
  const original = {id:7,incognito:false,url,status:'complete'}, manager = {id:8,incognito:false};
  let frame = {documentId:'original',url}; const removed = [];
  const base = 'chrome-extension://testing/';
  globalThis.chrome = {
    runtime:{getURL:path => base+path,sendMessage:async () => null}, extension:{inIncognitoContext:false},
    storage:{session:{set:async values => Object.assign(data,values),async get(keys) { return keys == null ? data : Object.fromEntries([].concat(keys).map(k=>[k,data[k]])); }}},
    webNavigation:{async getFrame({tabId,frameId}) { assert.equal(frameId,0); return tabId===7 ? frame : null; }},
    tabs:{create:async () => ({id:20}),async get(n) { assert.equal(n,7); return original; },async remove(n) { removed.push(n); }}
  };
  const sender = {tab:manager,frameId:0,url:base+'manager.html'};
  const message = {op:'queue-close-source',id,run};
  const rejected = async (msg=message,from=sender) => {
    const ok = await handleQueueRequest(msg,from).catch(()=>false);
    assert.equal(ok,false); assert.deepEqual(removed,[]);
  };
  try {
    await rejected({...message,run:'previous'});
    await rejected(message,{...sender,url:'https://example.test/fake'});
    await rejected(message,{...sender,frameId:1});
    await rejected(message,{...sender,tab:{...manager,incognito:true}});
    await rejected(message,{...sender,tab:{...manager,id:7}});
    frame = {url,documentId:'reloaded'}; await rejected();
    frame = {url:url+'2',documentId:'original'}; await rejected();
    frame = {url,documentId:'original'}; original.pendingUrl = 'https://elsewhere.test/'; await rejected();
    delete original.pendingUrl;
    data[statusPrefix+id].phase='fetching'; data[statusPrefix+id].readerMode='original'; await rejected();
    data[statusPrefix+id].phase='saving';
    const another = {...page,id:'other',run:'other-run',job:{kind:'record',tabId:7,sourceDoc:'original'}};
    data[pagePrefix+'other']=another; data[statusPrefix+'other']={phase:'recording',run:'other-run'}; await rejected();
    data[statusPrefix+'other'].phase='ready';
    assert.equal(await handleQueueRequest(message,sender),true);
    assert.deepEqual(removed,[7]);
  } finally { delete globalThis.chrome; }
});
