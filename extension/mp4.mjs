import { writeMediaBlocks } from './media.mjs';

// Keep the public names used by already shipped queues.
export { Mp4MergeError, classifyMergeError } from './mp4-merge-error.mjs';

const formatError = () => new Error('このTSの映像・音声をMP4にまとめられません。「元のTSを保存」で取得済みの動画を保存できます。');

function setDuration(box, offset, scale, seconds) {
  // The bundled mux.js generator emits version-zero movie and track headers.
  const value = Math.round(seconds * scale);
  new DataView(box.buffer, box.byteOffset, box.byteLength).setUint32(offset, value < 0xffffffff ? value : 0);
}

function finalizeHeader(bytes, seconds, find) {
  const view = box => new DataView(box.buffer, box.byteOffset, box.byteLength);
  const [movie] = find(bytes, ['moov', 'mvhd']);
  const timescale = view(movie).getUint32(12);
  setDuration(movie, 16, timescale, seconds);
  for (const track of find(bytes, ['moov', 'trak', 'tkhd'])) setDuration(track, 20, timescale, seconds);
  for (const media of find(bytes, ['moov', 'trak', 'mdia', 'mdhd'])) setDuration(media, 16, view(media).getUint32(12), seconds);
}

export async function exportTsAsMp4(file, ends, duration, writer, signal, progress) {
  signal.throwIfAborted();
  if (!Array.isArray(ends) || !ends.length || ends.at(-1) !== file.size ||
      ends.some((end,i) => !Number.isSafeInteger(end) || end <= (i ? ends[i-1] : 0))) throw formatError();
  const { Transmuxer, probe } = globalThis.muxjs;
  const muxer = new Transmuxer({ remux: true, keepOriginalTimestamps: false });
  let events = [], formats;
  muxer.on('data', segment => events.push(segment));

  async function finishSegment(end) {
    muxer.flush();
    if (!events.length) throw formatError();
    for (const event of events) {
      if (event.type !== 'combined' || !event.data.length) throw formatError();
      const descriptions = probe.findBox(event.initSegment, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
      const tracks = probe.tracks(event.initSegment);
      const signature = tracks.map((track, i) => track.id + '/' + track.codec + '/' + descriptions[i].join(',')).sort().join('|');
      if (!formats) {
        formats = signature;
        finalizeHeader(event.initSegment, duration, probe.findBox);
        await writeMediaBlocks(event.initSegment, writer, signal);
      } else if (formats !== signature) throw formatError();
      signal.throwIfAborted();
      await writeMediaBlocks(event.data, writer, signal);
    }
    events = [];
    progress(end / file.size);
  }

  // The disk stream can read ahead across segments. The transmuxer still flushes at the recorded HLS boundaries.
  const reader = file.stream().getReader();
  let consumed = 0, segment = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        signal.throwIfAborted();
        if (segment >= ends.length) throw formatError();
        const count = Math.min(value.byteLength - offset, ends[segment] - consumed);
        muxer.push(value.subarray(offset, offset + count));
        consumed += count;
        offset += count;
        if (consumed === ends[segment]) {
          await finishSegment(consumed);
          segment++;
        }
      }
    }
    signal.throwIfAborted();
    if (!formats || segment !== ends.length) throw formatError();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    muxer.dispose();
  }
}
