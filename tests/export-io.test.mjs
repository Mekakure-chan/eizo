import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { exportTsAsMp4 } from '../extension/mp4.mjs';
import { writeMediaBlocks } from '../extension/media.mjs';
import { acquireMedia, exportMedia } from '../extension/queue-transfer.mjs';
import { saveProgress } from '../extension/save-folder.mjs';
import { BlobSource, EncodedPacketSink, Input, MP4 } from '../extension/vendor/mediabunny-1.66.2.mjs';

const vendor = await readFile(new URL('../extension/vendor/mux-mp4.js',import.meta.url),'utf8');
globalThis.muxjs = runInNewContext(vendor + '\nglobalThis.muxjs;', {window:{},Uint8Array,DataView,ArrayBuffer});
// FFmpeg-generated H.264 and AAC, three half-second HLS segments.
const ts = new Uint8Array(await readFile(new URL('./fixtures/three-segments.ts',import.meta.url)));
const ends = [2632,4700,6768];
test('publishes a changing save percentage at most five times per second and reserves completion for the commit',()=>{
  let time=0;
  const seen=[],report=saveProgress(p=>seen.push(p),()=>time);
  for (const [t,fraction] of [[10,0],[1000,.14],[1100,.15],[1300,.185],[1700,.189],[1950,.85],[2300,.849],[2600,.9999],[2900,1]]) {
    time=t; report(fraction);
  }
  assert.deepEqual(seen,[.14,.19,.85,.99]);
});
function fileWithChunks(bytes,chunkSize,counts) {
  return {
    size:bytes.length,
    slice(start,end) { return fileWithChunks(bytes.subarray(start,end),chunkSize,counts); },
    stream() {
      counts.opened++; let position=0;
      return new ReadableStream({pull(controller) {
        if (position === bytes.length) { controller.close(); return; }
        const chunk = bytes.subarray(position,position+chunkSize);
        controller.enqueue(chunk); position+=chunk.length;
      }});
    }
  };
}

test('TS export reads one continuous stream and flushes exactly at all HLS boundaries',async () => {
  const signal = new AbortController().signal;
  let reference;
  for (const size of [137,3200,8192]) {
    const counts = {opened:0}, parts = [], progress = [];
    await exportTsAsMp4(fileWithChunks(ts,size,counts),ends,1.5,{write:p=>parts.push(p)},signal,p=>progress.push(p));
    assert.deepEqual(progress,ends.map(end=>end/ts.length));
    const output = Buffer.concat(parts.map(p=>Buffer.from(p)));
    if (reference) assert.deepEqual(output,reference);
    reference = output;
    assert.equal(counts.opened,1,'reading a new file stream for every segment stalls long exports');
  }
  const input = new Input({formats:[MP4],source:new BlobSource(new Blob([reference]))});
  try {
    const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
    let frames = 0, samples = 0;
    for await (const _ of new EncodedPacketSink(video).packets()) frames++;
    for await (const _ of new EncodedPacketSink(audio).packets()) samples++;
    assert.equal(frames,15); assert.ok(samples>=69 && samples<=73);
  } finally { input.dispose(); }
});

test('invalid or incomplete TS boundaries cannot produce a successful export',async () => {
  for (const boundaries of [[],[0,ts.length],[2632,2632,ts.length],[ts.length-188],[ts.length+188]]) {
    await assert.rejects(exportTsAsMp4(new Blob([ts]),boundaries,1.5,{write(){}},new AbortController().signal,()=>{}));
  }
  const controller=new AbortController(), written=[];
  await assert.rejects(exportTsAsMp4(fileWithChunks(ts,ts.length,{opened:0}),ends,1.5,{write:p=>written.push(p)},
    controller.signal,()=>controller.abort()),{name:'AbortError'});
  assert.equal(written.length,2,'only the first segment and its initialization may have been written');
});

test('ready media goes to the file writer in bounded file-backed slices, with progress and cancellation',async t => {
  const bytes = new Uint8Array(17*1024*1024+53);
  for (let n=0;n<bytes.length;n+=12991) bytes[n]=(n%251)+1;
  const file = new Blob([bytes]);
  const metadata = new Blob([JSON.stringify({kind:'file',bytes:file.size})]);
  const folder = {getDirectoryHandle:async()=>folder,getFileHandle:async name=>({getFile:async()=>name==='video'?file:metadata})};
  Object.defineProperty(navigator,'storage',{configurable:true,value:{getDirectory:async()=>folder}});
  t.after(()=>{delete navigator.storage;});
  const run = '01234567-89ab-cdef-0123-456789abcdef';
  const chunks=[],progress=[];
  await exportMedia(run,'mp4',{write:chunk=>chunks.push(chunk)},new AbortController().signal,p=>progress.push(p));
  assert.equal(chunks.length,5,'17 MiB should be written in four 4 MiB blocks and one tail');
  assert.ok(chunks.every(chunk=>chunk instanceof Blob && chunk.size<=4*1024*1024));
  assert.deepEqual(new Uint8Array(await new Blob(chunks).arrayBuffer()),bytes);
  assert.equal(progress.at(-1),1); assert.ok(progress.every((p,i)=>i===0 || progress[i-1]<p));
  const controller=new AbortController(); let calls=0;
  await assert.rejects(exportMedia(run,'mp4',{write(){calls++;controller.abort();}},controller.signal,()=>{}),{name:'AbortError'});
  assert.equal(calls,1);
});

test('a large muxed segment waits for each write and reuses only its own byte range', async () => {
  const block = 4 * 1024 * 1024;
  const source = new Uint8Array(block + 137).subarray(11, block + 113);
  const chunks = [];
  let finishFirst;
  const held = new Promise(resolve => { finishFirst = resolve; });
  const copying = writeMediaBlocks(source, {write(chunk) {
    chunks.push(chunk);
    if (chunks.length === 1) return held;
  }}, new AbortController().signal);
  await Promise.resolve();
  assert.equal(chunks.length, 1, 'a slow destination must hold back the next block');
  finishFirst();
  await copying;
  assert.deepEqual(chunks.map(c => [c.byteOffset, c.byteLength]), [[11,block],[11 + block,102]]);
  assert.ok(chunks.every(c => c.buffer === source.buffer));
});

test('a direct file checks both origins through its acquisition context before reading media', async t => {
  const source = 'https://source.example/clip.mp4', final = 'https://cdn.example/clip.mp4';
  const events = [];
  const writer = {abort:async () => events.push('abort'), write:assert.fail, close:assert.fail};
  const folder = {getDirectoryHandle:async () => folder,getFileHandle:async () => ({createWritable:async () => writer})};
  Object.defineProperty(navigator,'storage',{configurable:true,value:{getDirectory:async () => folder}});
  t.after(() => {delete navigator.storage;});
  t.mock.method(globalThis,'fetch',async (url,options) => {
    assert.equal(url,source); assert.equal(options.credentials,'omit'); assert.equal(options.referrerPolicy,'no-referrer');
    events.push('fetch');
    return {ok:true,url:final,body:{cancel:async () => events.push('cancel'), getReader:assert.fail}};
  });
  for (const denied of [source,final]) {
    events.length = 0;
    const authorize = async ([url]) => {
      events.push(url);
      if (url === denied) throw new Error('permission required');
    };
    const page = {run:crypto.randomUUID(),job:{kind:'file',url:source}};
    await assert.rejects(acquireMedia(page,{signal:new AbortController().signal,authorize,report:assert.fail}),/permission required/);
    assert.deepEqual(events,denied === source ? [source,'abort'] : [source,'fetch',final,'cancel','abort']);
  }
});
