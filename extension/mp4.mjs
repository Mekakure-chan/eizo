import { writeMediaBlocks } from './media.mjs';
import { TrackTime } from './mp4-track-time.mjs';
import { Mp4MergeError } from './mp4-merge-error.mjs';

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

// mux.js reports both clocks in 90 kHz ticks, even when the AAC track uses a different timescale.
function tsTimeline(muxer) {
  const timing = new Map(), tracks = new Map();
  let offset = 0;
  for (const kind of ['video', 'audio']) {
    muxer.on(kind + 'SegmentTimingInfo', value => timing.set(kind, value));
  }
  return {
    advance() {
      if (!timing.size) throw formatError();
      const rewinds = [];
      for (const [kind, {start, end, prependedContentDuration}] of timing) {
        if (!(end.dts > start.dts)) throw formatError();
        const last = tracks.get(kind);
        if (last && start.dts + (prependedContentDuration || 0) <= last.start) {
          rewinds.push(last.end - start.dts);
        }
      }
      if (rewinds.length) {
        if (rewinds.length !== timing.size) throw new Mp4MergeError('映像と音声の時刻が別々に巻き戻ったため、同期を確認できません。');
        // Move both tracks together, preserving their relative start and every compressed sample.
        offset = Math.max(...rewinds);
      }
      for (const [kind, {start, end}] of timing) {
        const time = tracks.get(kind)?.time ?? new TrackTime();
        time.add((start.dts + offset) / 90000, (end.dts - start.dts) / 90000);
        tracks.set(kind, {start:start.dts, end:end.dts + offset, time});
      }
      const primary = timing.get('video') || timing.get('audio');
      const start = Math.round(primary.start.pts + offset);
      timing.clear();
      return {offset, start, end:start + Math.round(primary.end.dts - primary.start.dts)};
    },
    verify(duration) {
      for (const [kind, track] of tracks) {
        track.time.verify(kind === 'video' ? '映像' : '音声', duration);
      }
    }
  };
}

// One ISO segment-index entry per HLS segment. Reserve only its header on disk;
// the compressed payload is written once, even for a multi-gigabyte movie.
function segmentIndex(trackId, entries) {
  const data = new Uint8Array(40 + 12 * entries.length), view = new DataView(data.buffer);
  view.setUint32(0, data.length);
  data.set([0x73,0x69,0x64,0x78,1],4); // sidx, version 1
  view.setUint32(12,trackId);
  view.setUint32(16,90000);
  view.setUint16(38,entries.length);
  for (const [i, entry] of entries.entries()) {
    const duration = (entries[i+1]?.start ?? entry.end) - entry.start;
    if (entry.start < 0 || duration <= 0 || duration > 0xffffffff || entry.size > 0x7fffffff) {
      // Unrepresentable ranges may still be valid MP4 fragments. Never publish a misleading index.
      data.set([0x66,0x72,0x65,0x65],4); // free
      return data;
    }
    const at = 40 + 12 * i;
    view.setUint32(at,entry.size);
    view.setUint32(at+4,duration);
    // Leave SAP type unspecified: not every input GOP is independently decodable.
  }
  view.setBigUint64(20,BigInt(entries[0].start));
  return data;
}

function shiftDecodeTimes(data, tracks, ticks, find) {
  for (const traf of find(data, ['moof', 'traf'])) {
    const [header] = find(traf, ['tfhd']), [time] = find(traf, ['tfdt']);
    const id = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4);
    const track = tracks.find(track => track.id === id);
    // The bundled mux.js writes 64-bit tfdt values.
    if (!track?.timescale || !time || time[0] !== 1 || time.length < 12) throw formatError();
    const view = new DataView(time.buffer, time.byteOffset, time.byteLength);
    view.setBigUint64(4, view.getBigUint64(4) + BigInt(Math.round(ticks * track.timescale / 90000)));
  }
}

export async function exportTsAsMp4(file, ends, duration, writer, signal, progress) {
  signal.throwIfAborted();
  if (!Array.isArray(ends) || !ends.length || ends.at(-1) !== file.size ||
      ends.some((end,i) => !Number.isSafeInteger(end) || end <= (i ? ends[i-1] : 0))) throw formatError();
  const { Transmuxer, probe } = globalThis.muxjs;
  const muxer = new Transmuxer({ remux: true, keepOriginalTimestamps: false });
  const timeline = tsTimeline(muxer);
  let events = [], formats, outputPosition = 0, indexPosition, groupLength, indexTrack;
  const indexed = typeof writer.seek === 'function', entries = [];
  muxer.on('data', segment => events.push(segment));

  async function finishSegment(end) {
    muxer.flush();
    if (!events.length) throw formatError();
    const clock = timeline.advance();
    let segmentSize = 0;
    for (const event of events) {
      if (!['combined', 'video', 'audio'].includes(event.type) || !event.data.length) throw formatError();
      const descriptions = probe.findBox(event.initSegment, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
      const tracks = probe.tracks(event.initSegment);
      const signature = tracks.map((track, i) => track.id + '/' + track.codec + '/' + descriptions[i].join(',')).sort().join('|');
      if (!formats) {
        formats = signature;
        finalizeHeader(event.initSegment, duration, probe.findBox);
        await writeMediaBlocks(event.initSegment, writer, signal);
        outputPosition += event.initSegment.length;
        indexTrack = (tracks.find(track => track.type === 'video') || tracks[0]).id;
      } else if (formats !== signature) throw formatError();
      if (indexed && !entries.length && !segmentSize) {
        groupLength = Math.min(0xffff, ends.length - segment);
        indexPosition = outputPosition;
        outputPosition += 40 + 12 * groupLength;
        await writer.seek(outputPosition);
      }
      if (clock.offset) shiftDecodeTimes(event.data, tracks, clock.offset, probe.findBox);
      signal.throwIfAborted();
      await writeMediaBlocks(event.data, writer, signal);
      segmentSize += event.data.length;
    }
    outputPosition += segmentSize;
    if (indexed) {
      entries.push({size:segmentSize, start:clock.start, end:clock.end});
      if (entries.length === groupLength) {
        await writer.write({type:'write',position:indexPosition,data:segmentIndex(indexTrack, entries)});
        await writer.seek(outputPosition);
        entries.length = 0;
      }
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
    timeline.verify(duration);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    muxer.dispose();
  }
}
