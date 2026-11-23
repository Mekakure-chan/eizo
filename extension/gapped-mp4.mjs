import {
  ADTS,
  MPEG_TS,
  MP4,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget
} from './vendor/mediabunny-1.66.2.mjs';
import { audioClockOffset } from './paired-mp4.mjs';
import { Mp4MergeError, classifyMergeError } from './mp4-merge-compat.mjs';

const EPSILON = 1e-6;
const noOverlap = '映像と音声の再生時刻が重なる区間がありません。';
const headersOnly = {metadataOnly:true};

function finiteNumber(value, name) {
  if (!Number.isFinite(value)) throw new Mp4MergeError(name + 'が不正です。');
  return value;
}

function mediaIntervals(file, track, kind) {
  if (!track || typeof track !== 'object' || !Array.isArray(track.segments) || !track.segments.length) {
    throw new Mp4MergeError(kind + 'の区間一覧がありません。');
  }
  if (track.initBytes !== undefined &&
      (!Number.isSafeInteger(track.initBytes) || track.initBytes < 0 || track.initBytes > file.size)) {
    throw new Mp4MergeError(kind + 'の初期化データ長が不正です。');
  }
  if (track.programTime !== undefined && !Number.isFinite(track.programTime)) {
    throw new Mp4MergeError(kind + 'の番組時刻が不正です。');
  }
  const intervals = [];
  for (const segment of track.segments) {
    if (!segment || typeof segment !== 'object') throw new Mp4MergeError(kind + 'の区間情報が不正です。');
    const start = finiteNumber(segment.start, kind + '区間の開始時刻');
    const end = finiteNumber(segment.end, kind + '区間の終了時刻');
    const byteStart = segment.byteStart;
    const byteEnd = segment.byteEnd;
    if (start < -EPSILON || end <= start + EPSILON) throw new Mp4MergeError(kind + '区間の時刻範囲が不正です。');
    if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) ||
        byteStart < 0 || byteEnd < byteStart || byteEnd > file.size) {
      throw new Mp4MergeError(kind + '区間のバイト範囲が不正です。');
    }
    // A zero-length range is the caller's explicit marker for a missing segment.
    if (byteEnd > byteStart) intervals.push({ start: Math.max(0, start), end, byteStart, byteEnd });
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start < intervals[i - 1].end - EPSILON) {
      throw new Mp4MergeError(kind + 'の区間が重複しています。');
    }
  }
  if (!intervals.length) throw new Mp4MergeError(kind + 'に保存できる区間がありません。');
  return intervals;
}

function intersections(video, audio) {
  const result = [];
  let i = 0, j = 0;
  while (i < video.length && j < audio.length) {
    const start = Math.max(video[i].start, audio[j].start);
    const end = Math.min(video[i].end, audio[j].end);
    if (end > start + EPSILON) result.push({ start, end });
    if (video[i].end < audio[j].end - EPSILON) i++;
    else if (audio[j].end < video[i].end - EPSILON) j++;
    else { i++; j++; }
  }
  return result;
}

function coalesce(intervals) {
  const result = [];
  for (const interval of intervals) {
    const previous = result.at(-1);
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else result.push({ start: interval.start, end: interval.end });
  }
  return result;
}

async function inspect(input, kind, intervals, format) {
  const name = kind === 'video' ? '映像' : '音声';
  const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
  if (!track) throw new Mp4MergeError('保存元に' + name + 'トラックがありません。');
  const codec = await track.getCodec();
  const supported = kind === 'video' ? format.getSupportedVideoCodecs() : format.getSupportedAudioCodecs();
  if (!codec || !supported.includes(codec)) {
    throw new Mp4MergeError(name + 'の形式をMP4に保存できません（' + (codec || '不明') + '）。');
  }
  const decoderConfig = await track.getDecoderConfig();
  const sink = new EncodedPacketSink(track);
  const first = await sink.getFirstPacket();
  if (!decoderConfig || !first) throw new Mp4MergeError(name + 'の区間が不完全です。');
  const origin = first.timestamp - intervals[0].start;
  if (!Number.isFinite(origin)) throw new Mp4MergeError(name + 'の再生時刻を確認できません。');
  return {
    track,
    codec,
    decoderConfig,
    sink,
    origin,
    format: await input.getFormat(),
    first
  };
}

async function keyAtOrAfter(sink, timestamp) {
  let packet = await sink.getKeyPacket(timestamp,headersOnly);
  if (!packet) packet = await sink.getFirstKeyPacket(headersOnly);
  while (packet && packet.timestamp < timestamp - EPSILON) packet = await sink.getNextKeyPacket(packet,headersOnly);
  return packet || null;
}

function playlistTime(media, packet) {
  return packet.timestamp - media.origin;
}

// Inspect only the final GOP when audio ends in the middle of healthy video.
// B-frames earlier in presentation order may depend on the first excluded packet.
async function decodableTail(video, firstKey, end, signal) {
  const nearEnd = await video.sink.getKeyPacket(video.origin + end - EPSILON,headersOnly);
  const key = nearEnd && nearEnd.sequenceNumber >= firstKey.sequenceNumber ? nearEnd : firstKey;
  let safeEnd = playlistTime(video,key);
  for await (const packet of video.sink.packets(key,undefined,headersOnly)) {
    signal.throwIfAborted();
    const start = playlistTime(video,packet), frameEnd = start + packet.duration;
    if (start >= end - EPSILON || frameEnd > end + EPSILON) {
      return {end:Math.min(end,safeEnd), stopBefore:packet.sequenceNumber};
    }
    safeEnd = Math.max(safeEnd,frameEnd);
  }
  return {end:Math.min(end,safeEnd), stopBefore:Infinity};
}

async function makeClips(video, audio, intervals, videoSpans, signal) {
  const clips = [];
  const omitted = [];
  for (const interval of intervals) {
    signal.throwIfAborted();
    const threshold = video.origin + interval.start;
    const key = await keyAtOrAfter(video.sink, threshold);
    if (!key) {
      omitted.push({ start: interval.start, end: interval.end });
      continue;
    }
    const videoStart = playlistTime(video, key);
    if (videoStart >= interval.end - EPSILON) {
      omitted.push({ start: interval.start, end: interval.end });
      continue;
    }
    const clip = {start:videoStart,end:interval.end,stopBefore:Infinity};
    if (audio && videoSpans.some(span => span.start < interval.end - EPSILON && span.end > interval.end + EPSILON)) {
      Object.assign(clip,await decodableTail(video,key,interval.end,signal));
      if (clip.end <= videoStart + EPSILON) {
        omitted.push({start:interval.start,end:interval.end});
        continue;
      }
    }
    clips.push(clip);
    if (videoStart > interval.start + EPSILON) omitted.push({ start: interval.start, end: videoStart });
    if (clip.end < interval.end - EPSILON) omitted.push({start:clip.end,end:interval.end});
  }
  if (!clips.length) throw new Mp4MergeError('保存を開始できる映像のキーフレームがありません。');

  const firstAxis = clips[0].start;
  let removed = 0;
  let previousEnd = firstAxis;
  for (const clip of clips) {
    removed += Math.max(0, clip.start - previousEnd);
    clip.removedBefore = removed;
    previousEnd = clip.end;
  }
  const globalOrigin = audio ? Math.min(video.origin, audio.origin + audio.clockOffset - audio.shift) : video.origin;
  const duration = clips.reduce((total,clip) => total + (clip.end - clip.start),0);
  return { clips, omitted, firstAxis, globalOrigin, duration };
}

function clipForTime(clips, sourceTime) {
  let low = 0, high = clips.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const clip = clips[middle];
    if (sourceTime < clip.start - EPSILON) high = middle - 1;
    else if (sourceTime >= clip.end - EPSILON) low = middle + 1;
    else return clip;
  }
  return null;
}

function outputTime(media, clip, packetTime, firstAxis, globalOrigin) {
  // Packet timestamps use each input's media clock. The playlist shift puts
  // separate renditions on one clock, while globalOrigin preserves a small
  // audio/video lead (for example AAC priming or video composition delay).
  return packetTime + media.clockOffset - globalOrigin - clip.removedBefore - firstAxis;
}

function* audioRanges(media, clips) {
  for (let i = 0; i < media.segments.length; i++) {
    const segment = media.segments[i];
    const clip = media.muxed && clipForTime(clips, segment.start + media.shift);
    // AAC in a shared segment can begin before, or end after, its video boundary.
    const wholeClip = clip && segment.end + media.shift <= clip.end + EPSILON ? clip : null;
    let last = segment;
    if (media.fragmentInit && wholeClip) {
      // A contiguous run of intact fMP4 fragments needs just one demuxer and init section.
      while (i + 1 < media.segments.length) {
        const next = media.segments[i + 1];
        if (next.byteStart !== last.byteEnd || Math.abs(next.start - last.end) > EPSILON ||
            next.end + media.shift > wholeClip.end + EPSILON) break;
        last = next;
        i++;
      }
    }
    yield {segment, byteEnd:last.byteEnd, wholeClip};
  }
}

async function* selectedPackets(media, clips, kind, firstAxis, globalOrigin, signal) {
  if (media.perSegment) {
    for (const {segment, byteEnd, wholeClip} of audioRanges(media, clips)) {
      signal.throwIfAborted();
      const bytes = media.file.slice(segment.byteStart, byteEnd);
      const source = media.fragmentInit ? new Blob([media.fragmentInit, bytes]) : bytes;
      const segmentInput = new Input({formats:[media.format], source:new BlobSource(source)});
      try {
        const track = await segmentInput.getPrimaryAudioTrack();
        if (!track) throw new Mp4MergeError('音声区間に音声トラックがありません。');
        const sink = new EncodedPacketSink(track);
        const first = await sink.getFirstPacket();
        if (!first) continue;
        for await (const packet of sink.packets()) {
          signal.throwIfAborted();
          const relative = segment.start + packet.timestamp - first.timestamp;
          const sourceTime = relative + media.shift;
          const clip = wholeClip || clipForTime(clips, sourceTime);
          if (!clip) continue;
          // Bare ADTS needs the reconstructed clock. TS and fMP4 carry timestamps.
          const packetTime = media.format === ADTS ? media.origin + relative : packet.timestamp;
          const timestamp = outputTime(media, clip, packetTime, firstAxis, globalOrigin);
          if (timestamp >= -EPSILON) yield { packet, timestamp };
        }
      } finally { segmentInput.dispose(); }
    }
    return;
  }
  for await (const packet of media.sink.packets()) {
    signal.throwIfAborted();
    const sourceTime = playlistTime(media, packet) + media.shift;
    const clip = clipForTime(clips, sourceTime);
    if (!clip) continue;
    if (kind === 'video' && packet.sequenceNumber >= clip.stopBefore) continue;
    const timestamp = outputTime(media, clip, packet.timestamp, firstAxis, globalOrigin);
    if (timestamp < -EPSILON) continue;
    yield { packet, timestamp };
  }
}

async function mux(video, audio, clipPlan, writer, signal, progress) {
  signal.throwIfAborted();
  const firstAxis = clipPlan.firstAxis;
  const globalOrigin = clipPlan.globalOrigin;
  const clips = clipPlan.clips;
  const expectedDuration = clipPlan.duration;
  if (!(expectedDuration > 0)) throw new Mp4MergeError(noOverlap);

  const target = new StreamTarget(new WritableStream({
    write(chunk) {
      signal.throwIfAborted();
      return writer.write(chunk);
    }
  }), { chunked: true, chunkSize: 1024 * 1024 });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  const image = new EncodedVideoPacketSource(video.codec);
  const sound = audio ? new EncodedAudioPacketSource(audio.codec) : null;
  output.addVideoTrack(image, { rotation: await video.track.getRotation() });
  if (sound) output.addAudioTrack(sound);

  const vi = selectedPackets(video, clips, 'video', firstAxis, globalOrigin, signal);
  const ai = audio ? selectedPackets(audio, clips, 'audio', firstAxis, globalOrigin, signal) : null;
  let v, a;
  let writtenVideo = 0, writtenAudio = 0, maxTime = 0, lastProgress = -1;
  let videoMeta = { decoderConfig: video.decoderConfig };
  let audioMeta = audio ? { decoderConfig: audio.decoderConfig } : null;
  try {
    await output.start();
    v = (await vi.next()).value;
    a = ai ? (await ai.next()).value : undefined;
    for (;;) {
      signal.throwIfAborted();
      if (!v && !a) break;
      const takeVideo = !!v && (!a || v.timestamp <= a.timestamp);
      const item = takeVideo ? v : a;
      const timestamp = item.timestamp;
      maxTime = Math.max(maxTime, timestamp + item.packet.duration);
      if (takeVideo) {
        await image.add(item.packet.clone({ timestamp }), videoMeta);
        videoMeta = undefined;
        writtenVideo++;
        v = (await vi.next()).value;
      } else {
        await sound.add(item.packet.clone({ timestamp }), audioMeta);
        audioMeta = undefined;
        writtenAudio++;
        a = (await ai.next()).value;
      }
      const value = Math.min(0.99, Math.max(0, maxTime / expectedDuration));
      if (value > lastProgress) {
        lastProgress = value;
        progress?.(value);
      }
    }
    if (!writtenVideo || (audio && !writtenAudio)) throw new Mp4MergeError(noOverlap);
    image.close();
    sound?.close();
    signal.throwIfAborted();
    await output.finalize();
    signal.throwIfAborted();
    progress?.(1);
    return maxTime;
  } catch (error) {
    signal.throwIfAborted();
    throw classifyMergeError(error);
  } finally {
    await Promise.allSettled([vi.return(), ai?.return()]);
    if (output.state === 'started') await output.cancel().catch(() => {});
  }
}

export async function prepareGappedMp4(videoFile, audioFileOrNull, tracks, signal) {
  if (!signal) signal = new AbortController().signal;
  signal.throwIfAborted();
  if (!(videoFile instanceof Blob) || (audioFileOrNull !== null && !(audioFileOrNull instanceof Blob))) {
    throw new TypeError('保存元の映像・音声ファイルが不正です。');
  }
  if (!tracks?.video) throw new Mp4MergeError('映像の区間一覧がありません。');

  const videoIntervals = mediaIntervals(videoFile, tracks.video, '映像');
  // A muxed file has one segment table for both primary tracks. Callers may
  // therefore omit tracks.audio; discover that track after opening the input.
  const audioSpec = tracks.audio || (audioFileOrNull === null ? tracks.video : null);
  const audioIntervals = audioSpec ? mediaIntervals(audioFileOrNull || videoFile, audioSpec, '音声') : null;

  const videoInput = new Input({ formats: [MP4, MPEG_TS], source: new BlobSource(videoFile) });
  const audioInput = audioFileOrNull
    ? new Input({ formats: [MP4, MPEG_TS, ADTS], source: new BlobSource(audioFileOrNull) })
    : videoInput;
  const dispose = () => {
    videoInput.dispose();
    if (audioInput !== videoInput) audioInput.dispose();
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    const format = new Mp4OutputFormat();
    const video = await inspect(videoInput, 'video', videoIntervals, format);
    let audio = null;
    if (tracks.audio) {
      audio = await inspect(audioInput, 'audio', audioIntervals, format);
      if (audioInput === videoInput && audio.track === video.track) {
        throw new Mp4MergeError('映像と音声を別トラックとして確認できません。');
      }
    } else if (audioFileOrNull === null) {
      // A muxed TS/fMP4 may carry audio even when the acquisition metadata
      // only recorded the video table. Video-only files simply return null.
      const candidate = await audioInput.getPrimaryAudioTrack();
      if (candidate) audio = await inspect(audioInput, 'audio', audioIntervals, format);
    }
    if (audio) {
      audio.file = audioFileOrNull || videoFile;
      audio.segments = audioIntervals;
      audio.muxed = audioInput === videoInput;
      const initBytes = audioSpec.initBytes ?? audioIntervals[0].byteStart;
      if (audio.muxed && audio.format === MP4 && initBytes > 0) audio.fragmentInit = audio.file.slice(0, initBytes);
      audio.perSegment = audio.format === ADTS || audio.format === MPEG_TS || !!audio.fragmentInit;
    }
    video.shift = 0;
    video.clockOffset = 0;
    if (audio) {
      audio.shift = 0;
      audio.clockOffset = 0;
      if (audioInput !== videoInput) {
        audio.clockOffset = await audioClockOffset(video,audio,audioInput,tracks,video.origin,audio.origin);
        if (tracks.video.programTime !== undefined && audioSpec.programTime !== undefined) {
          audio.shift = audioSpec.programTime - tracks.video.programTime;
        } else {
          const difference = audio.origin + audio.clockOffset - video.origin;
          // Preserve normal AAC priming / video reordering at the ends. A
          // larger offset changes which parts of the two playlists overlap.
          const preroll = Math.max(.125, 3 * video.first.duration, audio.first.duration);
          if (Math.abs(difference) > preroll) audio.shift = difference;
        }
      }
    }
    const shiftedAudioIntervals = audio
      ? audioIntervals.map(({ start, end }) => ({ start: start + audio.shift, end: end + audio.shift })) : null;
    const videoSpans = coalesce(videoIntervals);
    const common = audio ? intersections(videoSpans,coalesce(shiftedAudioIntervals)) : videoSpans;
    if (!common.length) throw new Mp4MergeError(noOverlap);
    const clipPlan = await makeClips(video, audio, common, videoSpans, signal);
    return {
      duration:clipPlan.duration,
      ...(clipPlan.omitted.length ? { omitted: clipPlan.omitted } : {}),
      dispose,
      writeTo: (writer, writeSignal, progress) => mux(video, audio, clipPlan, writer,
        writeSignal || signal, progress)
    };
  } catch (error) {
    dispose();
    signal.throwIfAborted();
    throw classifyMergeError(error);
  } finally {
    signal.removeEventListener('abort', dispose);
  }
}
