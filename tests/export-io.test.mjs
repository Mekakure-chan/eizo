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

test('a repeated TS clock starts a new stretch of the saved movie instead of overwriting its playback time', async () => {
  const cycles = 24;
  const file = new Blob(Array(cycles).fill(ts));
  const boundaries = Array.from({length:cycles}, (_, i) => ends.map(end => i * ts.length + end)).flat();
  const chunks = [];
  await exportTsAsMp4(file, boundaries, 36, {write:chunk => chunks.push(chunk)}, new AbortController().signal, () => {});
  const input = new Input({formats:[MP4], source:new BlobSource(new Blob(chunks))});
  try {
    for (const [track, count] of [[await input.getPrimaryVideoTrack(), 360], [await input.getPrimaryAudioTrack(), 1704]]) {
      let n = 0, previous = -Infinity, end = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        assert.ok(packet.timestamp > previous, 'the fixture has no reordered frames');
        previous = packet.timestamp;
        end = packet.timestamp + packet.duration;
        n++;
      }
      assert.equal(n,count);
      assert.ok(end >= 36 - .03 && end < 36.5, 'the last packet must reach the end of the movie');
    }
  } finally { input.dispose(); }
});

test('a short TS payload cannot be reported as a full length MP4 by setting its movie header', async () => {
  await assert.rejects(exportTsAsMp4(new Blob([ts]),ends,36,{write(){}},new AbortController().signal,()=>{}),
    {name:'Mp4MergeError',message:/0:36/});
});

test('overlapping but increasing TS clocks cannot conceal a substantially short output timeline', async () => {
  const blocks = [];
  // The same closed GOP advances by just 0.1 s per 0.5 s segment. Shift the
  // PTS/DTS in the PES headers while leaving all encoded audio and video intact.
  for (let i=0; i<24; i++) {
    const block = ts.slice(0, ends[0]);
    for (let at=0; at<block.length; at+=188) {
      if (!(block[at+1] & 64) || !(block[at+3] & 16)) continue;
      const pes = at + 4 + ((block[at+3] & 32) ? block[at+4]+1 : 0);
      if (block[pes] || block[pes+1] || block[pes+2] !== 1 || !(block[pes+7] & 128)) continue;
      const stamps = (block[pes+7] & 64) ? 2 : 1;
      for (let j=0; j<stamps; j++) {
        const p = pes + 9 + 5*j;
        const time = (block[p] & 14)*2**29 + block[p+1]*2**22 + (block[p+2] >> 1)*2**15 +
          block[p+3]*128 + (block[p+4] >> 1) + i*9000;
        block[p] = (block[p]&0xf1) | ((Math.floor(time/2**30)&7)<<1);
        block[p+1] = Math.floor(time/2**22)&255;
        block[p+2] = ((Math.floor(time/2**15)&127)<<1)|1;
        block[p+3] = Math.floor(time/128)&255;
        block[p+4] = ((time&127)<<1)|1;
      }
    }
    blocks.push(block);
  }
  await assert.rejects(exportTsAsMp4(new Blob(blocks),blocks.map((_,i)=>(i+1)*ends[0]),12,
    {write(){}},new AbortController().signal,()=>{}),{name:'Mp4MergeError',message:/0:12/});
});

test('a seekable TS export puts an index before the payload with correct byte ranges and times', async () => {
  const bytes = Buffer.alloc(32768);
  let pos = 0, size = 0;
  const writer = {
    seek(offset) { pos = offset; },
    write(chunk) {
      if (chunk.type === 'write') { pos = chunk.position; chunk = chunk.data; }
      bytes.set(chunk,pos); pos += chunk.length; size = Math.max(size,pos);
    }
  };
  await exportTsAsMp4(new Blob([ts]),ends,1.5,writer,new AbortController().signal,()=>{});
  const start = bytes.indexOf('sidx') - 4;
  assert.ok(start > 0 && start < bytes.indexOf('mdat'), 'players can read the seek table in the initial range');
  assert.equal(bytes[start+8],1);
  assert.equal(bytes.readUInt32BE(start+16),90000);
  assert.equal(bytes.readBigUInt64BE(start+20),0n);
  assert.equal(bytes.readBigUInt64BE(start+28),0n);
  assert.equal(bytes.readUInt16BE(start+38),3);
  let target = start + bytes.readUInt32BE(start);
  for (let i=0; i<3; i++) {
    assert.equal(bytes.toString('ascii',target+4,target+8),'moof');
    const entry = start+40+12*i;
    assert.equal(bytes.readUInt32BE(entry+4),45000);
    target += bytes.readUInt32BE(entry);
  }
  assert.equal(target,size);
});

test('a complete HTTP response with only a short fMP4 cannot become a ready HLS archive', async t => {
  const media = await readFile(new URL('./fixtures/muxed-fragments.mp4',import.meta.url));
  const base = 'https://local.example/';
  const resources = new Map([
    [base+'list.m3u8','#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:60,\npart.m4s\n#EXT-X-ENDLIST'],
    [base+'init.mp4',media.subarray(0,1306)], [base+'part.m4s',media.subarray(1306)]
  ]);
  const chunks = [];
  const file = {createWritable:async () => ({write:async bytes=>chunks.push(bytes),close:async()=>{},abort:async()=>{}}),
    getFile:async () => new Blob(chunks)};
  const folder = {getDirectoryHandle:async()=>folder,getFileHandle:async name=>name==='video' ? file : {
    createWritable:async()=>({write:async()=>{},close:async()=>{}})}};
  Object.defineProperty(navigator,'storage',{configurable:true,value:{getDirectory:async()=>folder}});
  t.after(()=>{delete navigator.storage;});
  const signal = new AbortController().signal;
  const openPlayer = async () => ({dispose:async()=>{}, fetchResource:async url=>{
    const response = new Response(resources.get(url));
    return Object.defineProperty(response,'url',{value:url});
  }});
  await assert.rejects(acquireMedia({run:crypto.randomUUID(),job:{kind:'hls',url:base+'list.m3u8'}},
    {openPlayer,signal,stop:signal,authorize:async()=>{},report:()=>{}}),{name:'Mp4MergeError',message:/1:00/});
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
