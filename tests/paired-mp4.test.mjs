import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { preparePair } from '../extension/paired-mp4.mjs';
import { BlobSource, EncodedPacketSink, Input, MP4 } from '../extension/vendor/mediabunny-1.66.2.mjs';

// Small FFmpeg-generated fragmented MP4s. Both use track ID 1; the video includes B-frames.
const fixture = async kind => new Blob([await readFile(new URL('./fixtures/' + kind + '-fragments.mp4', import.meta.url))]);
const capture = { video: {}, audio: {}, partial: false };

async function packets(file, kind) {
  const input = new Input({ source: new BlobSource(file), formats: [MP4] });
  try {
    const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
    const result = [];
    for await (const p of new EncodedPacketSink(track).packets()) result.push({ time: p.timestamp, data: p.data });
    return result;
  } finally { input.dispose(); }
}

async function write(pair, signal) {
  let bytes = new Uint8Array(0);
  await pair.writeTo({ write({ data, position }) {
    if (position + data.length > bytes.length) {
      const larger = new Uint8Array(position + data.length);
      larger.set(bytes);
      bytes = larger;
    }
    bytes.set(data, position);
  } }, signal, () => {});
  return new Blob([bytes]);
}

for (const live of [false, true]) {
  test('separate MP4s retain every packet and their shared clock for ' + (live ? 'a completed live event' : 'an archive'), async () => {
    const [v, a] = await Promise.all([fixture('video'), fixture('audio')]);
    const signal = new AbortController().signal;
    const pair = await preparePair(v, a, capture, live, signal);
    try {
      await assert.rejects(write(pair, AbortSignal.abort()), { name: 'AbortError' });
      const output = await write(pair, signal);
      const original = { video: await packets(v, 'video'), audio: await packets(a, 'audio') };
      const origin = Math.min(original.video[0].time, original.audio[0].time);
      for (const kind of ['video', 'audio']) {
        const saved = await packets(output, kind), source = original[kind];
        assert.equal(saved.length, source.length);
        for (const [i, packet] of saved.entries()) {
          assert.deepEqual(packet.data, source[i].data);
          assert.ok(Math.abs(packet.time - (source[i].time - origin)) < 0.0001);
        }
      }
    } finally { pair.dispose(); }
  });
}

test('video alone cannot satisfy an external audio rendition', async () => {
  const file = await fixture('video');
  await assert.rejects(preparePair(file, file, capture, false, new AbortController().signal), {name:'Mp4MergeError', message:/音声トラック/});
});

test('unrecognized media is a terminal join failure', async () => {
  const file = new Blob([new Uint8Array(512)]);
  await assert.rejects(preparePair(file,file,capture,false,new AbortController().signal),
    {name:'Mp4MergeError', message:/形式/});
});
