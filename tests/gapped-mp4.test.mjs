import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { prepareGappedMp4 } from '../extension/gapped-mp4.mjs';
import { BlobSource, EncodedPacketSink, Input, MP4, MPEG_TS } from '../extension/vendor/mediabunny-1.66.2.mjs';

const tsBytes = new Uint8Array(await readFile(new URL('./fixtures/three-segments.ts', import.meta.url)));
const sourceEnds = [2632, 4700, tsBytes.length];

function muxedGap() {
  const bytes = new Uint8Array(sourceEnds[0] + (sourceEnds[2] - sourceEnds[1]));
  bytes.set(tsBytes.subarray(0, sourceEnds[0]));
  bytes.set(tsBytes.subarray(sourceEnds[1]), sourceEnds[0]);
  const tracks = {
    video: { initBytes: 0, segments: [
      { start: 0, end: .5, byteStart: 0, byteEnd: sourceEnds[0] },
      { start: .5, end: 1, byteStart: sourceEnds[0], byteEnd: sourceEnds[0] },
      { start: 1, end: 1.5, byteStart: sourceEnds[0], byteEnd: bytes.length }
    ] },
    audio: { initBytes: 0, segments: [
      { start: 0, end: .5, byteStart: 0, byteEnd: sourceEnds[0] },
      { start: .5, end: 1, byteStart: sourceEnds[0], byteEnd: sourceEnds[0] },
      { start: 1, end: 1.5, byteStart: sourceEnds[0], byteEnd: bytes.length }
    ] }
  };
  return { file: new Blob([bytes]), tracks };
}

async function packetTimes(file, kind, format = MP4) {
  const input = new Input({ formats: [format], source: new BlobSource(file) });
  try {
    const track = await input['getPrimary' + (kind === 'video' ? 'Video' : 'Audio') + 'Track']();
    const packets = [];
    for await (const packet of new EncodedPacketSink(track).packets()) {
      packets.push({ timestamp: packet.timestamp, data: packet.data });
    }
    return packets;
  } finally { input.dispose(); }
}

async function writePrepared(prepared, signal = new AbortController().signal) {
  let bytes = new Uint8Array(0);
  await prepared.writeTo({ write({ data, position }) {
    if (position + data.length > bytes.length) {
      const larger = new Uint8Array(position + data.length);
      larger.set(bytes);
      bytes = larger;
    }
    bytes.set(data, position);
  } }, signal, () => {});
  return new Blob([bytes]);
}

test('joins surviving muxed TS intervals and retimes both tracks', async () => {
  const { file, tracks } = muxedGap();
  delete tracks.audio;
  const prepared = await prepareGappedMp4(file, null, tracks, new AbortController().signal);
  try {
    assert.ok(prepared.duration > .95 && prepared.duration < 1.1);
    const output = await writePrepared(prepared);
    const video = await packetTimes(output, 'video');
    const audio = await packetTimes(output, 'audio');
    assert.equal(video.length, 10);
    const sourceAudio = (await Promise.all(tracks.video.segments.filter(s => s.byteEnd > s.byteStart).map(s =>
      packetTimes(file.slice(s.byteStart,s.byteEnd),'audio',MPEG_TS)))).flat();
    assert.equal(audio.length,sourceAudio.length,'keep the AAC tail of each complete retained TS segment');
    for (const [i,packet] of sourceAudio.entries()) {
      const header = (packet.data[1] & 1) ? 7 : 9;
      assert.deepEqual(audio[i].data,packet.data.subarray(header));
    }
    assert.ok(video.some(packet => packet.timestamp > .45 && packet.timestamp < .6), 'the third segment remains after the compacted gap');
    assert.ok(video.every((packet, i) => i === 0 || Number.isFinite(packet.timestamp)));
    assert.ok(audio.every(packet => packet.timestamp >= -1e-6));
    const audioTimes = audio.map(packet => packet.timestamp).sort((a, b) => a - b);
    const maxAudioDelta = Math.max(...audioTimes.slice(1).map((time, i) => time - audioTimes[i]));
    assert.ok(maxAudioDelta <= .04, 'surviving TS audio stays continuous across the removed segment');
  } finally { prepared.dispose(); }
});

test('keeps every AAC sample carried by the surviving muxed MP4 fragments at a video cut', async () => {
  // The existing three-segments.ts fixture remuxed as fMP4. Its first 0.5 s
  // video fragment carries an AAC sample at 0.512 s, after the nominal cut.
  const file = new Blob([await readFile(new URL('./fixtures/muxed-fragments.mp4',import.meta.url))]);
  const init = file.slice(0,1306), first = file.slice(1306,2581), last = file.slice(3135);
  const joined = new Blob([init,first,last]);
  const cut = await prepareGappedMp4(joined,null,{video:{initBytes:init.size,segments:[
    {start:0,end:.5,byteStart:init.size,byteEnd:2581}, {start:.5,end:1,byteStart:2581,byteEnd:2581},
    {start:1,end:1.5,byteStart:2581,byteEnd:joined.size}
  ]}});
  try {
    const [before,after,saved] = await Promise.all([new Blob([init,first]),new Blob([init,last]),await writePrepared(cut)]
      .map(blob => packetTimes(blob,'audio')));
    assert.equal(before.length,25);
    assert.equal(after.length,24);
    assert.equal(saved.length,49,'all AAC samples from both intact fragments survive');
    assert.deepEqual(saved.map(p => p.data), [...before,...after].map(p => p.data));
    const times = before.map(p => p.timestamp).concat(after.map(p => p.timestamp-.5));
    saved.forEach((p,i) => assert.ok(Math.abs(p.timestamp-times[i]) < .0001));
  } finally { cut.dispose(); }
});

test('all missing intervals fail before writing an MP4', async () => {
  const { file, tracks } = muxedGap();
  for (const kind of ['video', 'audio']) {
    tracks[kind].segments = tracks[kind].segments.map(segment => ({ ...segment, byteStart: 0, byteEnd: 0 }));
  }
  await assert.rejects(
    prepareGappedMp4(file, null, tracks, new AbortController().signal),
    /保存できる区間/
  );
});

test('a gapped export exposes playback metadata before the first sample', async () => {
  const {file,tracks} = muxedGap();
  const cut = await prepareGappedMp4(file,null,tracks);
  try {
    const bytes = Buffer.from(await (await writePrepared(cut)).arrayBuffer());
    assert.ok(bytes.indexOf('moov') > 0 && bytes.indexOf('moov') < bytes.indexOf('mdat'));
  } finally { cut.dispose(); }
});

test('a long retained interval cannot silently end after its first few video packets', async () => {
  const {file,tracks} = muxedGap();
  delete tracks.audio;
  tracks.video.segments.at(-1).end = 62;
  const cut = await prepareGappedMp4(file,null,tracks);
  try {
    await assert.rejects(writePrepared(cut),{name:'Mp4MergeError',message:/1:0/});
  } finally { cut.dispose(); }
});

test('reports an irreversible join when AAC presentation times reverse across a missing fragment', async () => {
  const bytes = await readFile(new URL('./fixtures/muxed-fragments.mp4', import.meta.url));
  const last = Buffer.from(bytes.subarray(3135));
  const audioClock = last.lastIndexOf('tfdt') + 8;
  // After the cut the last fragment starts 65 ticks before the previous AAC sample (48 kHz).
  last.writeBigUInt64BE(last.readBigUInt64BE(audioClock) - 641n, audioClock);
  const file = new Blob([bytes.subarray(0,2581), last]);
  const cut = await prepareGappedMp4(file, null, {video:{initBytes:1306, segments:[
    {start:0,end:.5,byteStart:1306,byteEnd:2581}, {start:.5,end:1,byteStart:2581,byteEnd:2581},
    {start:1,end:1.5,byteStart:2581,byteEnd:file.size}
  ]}});
  try {
    await assert.rejects(writePrepared(cut), {name:'Mp4MergeError', message:/再生時刻/});
  } finally { cut.dispose(); }
});

test('a destination write failure on a joined MP4 remains recoverable', async () => {
  const {file, tracks} = muxedGap();
  const cut = await prepareGappedMp4(file, null, tracks);
  try {
    const full = new DOMException('disk full','QuotaExceededError');
    await assert.rejects(cut.writeTo({write() { throw full; }}, new AbortController().signal), error => error === full);
    assert.ok((await writePrepared(cut)).size > 0);
  } finally { cut.dispose(); }
});

test('cancellation stops a gapped export', async () => {
  const { file, tracks } = muxedGap();
  const prepared = await prepareGappedMp4(file, null, tracks, new AbortController().signal);
  try {
    const controller = new AbortController();
    await assert.rejects(prepared.writeTo({ write() { controller.abort(); } }, controller.signal, () => {}), { name: 'AbortError' });
  } finally { prepared.dispose(); }
});

// Video has three closed GOPs. Keep the first and last. The AAC fixture is a
// single fragment with a 48 kHz media timescale and a version-1 tfdt box.
async function fragmentPair(audioClock, videoDate, audioDate) {
  const v = await readFile(new URL('./fixtures/video-fragments.mp4', import.meta.url));
  const a = await readFile(new URL('./fixtures/audio-fragments.mp4', import.meta.url));
  const at = a.indexOf('tfdt') + 8;
  a.writeBigUInt64BE(a.readBigUInt64BE(at) + BigInt(audioClock * 48000),at);
  return {
    video:new Blob([v.subarray(0,1043),v.subarray(1315,1455)]), audio:new Blob([a]),
    tracks:{
      video:{initBytes:771,programTime:videoDate,segments:[
        {start:0,end:.28,byteStart:771,byteEnd:1043}, {start:.28,end:.56,byteStart:1043,byteEnd:1043},
        {start:.56,end:.6,byteStart:1043,byteEnd:1183}
      ]},
      audio:{initBytes:729,programTime:audioDate,segments:[{start:0,end:.721333,byteStart:729,byteEnd:a.length}]}
    }
  };
}

test('program dates align independently clocked audio with video across a real gap', async () => {
  for (const audioDate of [100,99.96,100.04]) {
    const {video,audio,tracks} = await fragmentPair(8,100,audioDate);
    const prepared = await prepareGappedMp4(video,audio,tracks);
    try {
      const output = await writePrepared(prepared);
      const [v,a] = await Promise.all([packetTimes(output,'video'), packetTimes(output,'audio')]);
      assert.ok(Math.min(v[0].timestamp,a[0].timestamp) < .001,'the first retained clip starts at zero');
      assert.ok(a.at(-1).timestamp < .34 && v.at(-1).timestamp < .34,'both tracks fit the compacted movie');
      assert.ok(Math.abs(a.at(-1).timestamp-v.at(-1).timestamp) < .06,'audio stays beside the last video frame');
    } finally { prepared.dispose(); }
  }
});

test('undated separate presentations with no common media timestamps cannot become a saved movie', async () => {
  const {video,audio,tracks} = await fragmentPair(8);
  await assert.rejects(prepareGappedMp4(video,audio,tracks),/重なる区間/);
});

async function packedAudioCut(from, until) {
  const video = new Blob([await readFile(new URL('./fixtures/video-fragments.mp4',import.meta.url))]);
  const frames = await packetTimes(new Blob([tsBytes]),'audio',MPEG_TS);
  const step = frames[1].timestamp - frames[0].timestamp;
  const first = new Blob(frames.slice(0,from).map(f => f.data)), last = new Blob(frames.slice(until,34).map(f => f.data));
  const audio = new Blob([first,last]);
  const tracks = {
    video:{programTime:100,initBytes:771,segments:[{start:0,end:.6,byteStart:771,byteEnd:video.size}]},
    audio:{programTime:100,initBytes:0,segments:[
      ...(from ? [{start:0,end:from*step,byteStart:0,byteEnd:first.size}] : []),
      {start:from*step,end:until*step,byteStart:first.size,byteEnd:first.size},
      {start:until*step,end:34*step,byteStart:first.size,byteEnd:audio.size}
    ]}
  };
  return {video,audio,tracks,step};
}

test('packed audio without timing metadata cannot silently drift in a gapped export', async () => {
  const {video,audio,tracks} = await packedAudioCut(5,10);
  delete tracks.video.programTime;
  delete tracks.audio.programTime;
  await assert.rejects(prepareGappedMp4(video,audio,tracks),/時刻情報/);
});

test('an audio-only cut does not keep B-frames that depend on an omitted reference', async () => {
  const {video,audio,tracks,step} = await packedAudioCut(5,10);
  const source = await packetTimes(video,'video');
  const cut = await prepareGappedMp4(video,audio,tracks);
  try {
    const result = await packetTimes(await writePrepared(cut),'video');
    // The second packet in decode order is a future reference, past the cut.
    // The intact keyframe and the next two independently decodable GOPs survive.
    assert.deepEqual(result.map(p => p.data),[source[0],...source.slice(7)].map(p => p.data));
    assert.ok(cut.omitted.some(gap => Math.abs(gap.start-.04)<.001 && Math.abs(gap.end-5*step)<.001));
    assert.ok(Math.abs(result[1].timestamp-.04)<.001,'the next keyframe follows the last decodable frame');
  } finally { cut.dispose(); }
});

test('a leading audio gap compacts the reported cut up to the first decodable video frame', async () => {
  const {video,audio,tracks} = await packedAudioCut(0,5);
  const cut = await prepareGappedMp4(video,audio,tracks);
  try {
    const output = await writePrepared(cut);
    const [v,a] = await Promise.all([packetTimes(output,'video'),packetTimes(output,'audio')]);
    assert.ok(Math.abs(v[0].timestamp)<.001,'the first keyframe starts the movie');
    assert.ok(a[0].timestamp<.025,'the first retained audio sample is within one AAC frame');
    assert.ok(Math.abs(cut.duration-.32)<.001,'the discarded pre-keyframe interval is absent from the duration');
  } finally { cut.dispose(); }
});

test('exports a video-only fragmented MP4 without an audio file', async () => {
  const file = new Blob([await readFile(new URL('./fixtures/video-fragments.mp4', import.meta.url))]);
  const prepared = await prepareGappedMp4(file, null, {
    video: { initBytes: 771, segments: [
      { start: 0, end: .24, byteStart: 771, byteEnd: 1043 },
      { start: .24, end: .48, byteStart: 1043, byteEnd: 1315 },
      { start: .48, end: .68, byteStart: 1315, byteEnd: 1455 }
    ] }
  }, new AbortController().signal);
  try {
    const output = await writePrepared(prepared);
    const video = await packetTimes(output, 'video');
    assert.equal(video.length, 15);
    assert.ok(Math.abs(video[0].timestamp) < 1e-6);
    assert.ok(prepared.duration > .5 && prepared.duration < .7);
  } finally { prepared.dispose(); }
});
