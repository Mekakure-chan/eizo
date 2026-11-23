import { ADTS, MPEG_TS, MP4, BlobSource, Input, EncodedPacketSink, EncodedVideoPacketSource,
  EncodedAudioPacketSource, Mp4OutputFormat, Output, StreamTarget } from './vendor/mediabunny-1.66.2.mjs';
import { Mp4MergeError, classifyMergeError } from './mp4-merge-compat.mjs';

const wrapPeriod = 2 ** 33 / 90000;
const noOverlap = '映像と音声の再生時刻が重なる区間がありません。';

async function packedStart(input) {
  const value = (await input.getMetadataTags()).raw?.PRIV;
  const owner = 'com.apple.streaming.transportStreamTimestamp';
  for (const frame of Array.isArray(value) ? value : [value]) {
    if (!(frame instanceof Uint8Array) || frame.length !== owner.length + 9 || frame[owner.length] !== 0) continue;
    if (new TextDecoder().decode(frame.subarray(0, owner.length)) !== owner) continue;
    const ticks = new DataView(frame.buffer, frame.byteOffset + owner.length + 1, 8).getBigUint64(0);
    if (ticks < 2n ** 33n) return Number(ticks) / 90000;
  }
  return null;
}

async function inspect(input, kind, format) {
  const name = kind === 'video' ? '映像' : '音声';
  const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
  if (!track) throw new Mp4MergeError('選択した配信に' + name + 'トラックがありません。マスターのm3u8を指定してください。');
  const codec = await track.getCodec();
  const supported = kind === 'video' ? format.getSupportedVideoCodecs() : format.getSupportedAudioCodecs();
  if (!supported.includes(codec)) throw new Mp4MergeError(name + 'の形式をMP4に保存できません（' + (codec || '不明') + '）。');
  const decoderConfig = await track.getDecoderConfig();
  const sink = new EncodedPacketSink(track);
  const first = await sink.getFirstPacket();
  const end = await track.computeDurationOrNull();
  if (!decoderConfig || !first || end === null || end <= first.timestamp) throw new Mp4MergeError(name + 'の区間が不完全です。');
  return { track, codec, decoderConfig, sink, first, end, format: await input.getFormat() };
}

// Both packet streams keep their original presentation clocks. DTS order is retained inside each stream.
export async function audioClockOffset(video, audio, audioInput, capture, videoOrigin = video.first.timestamp, audioOrigin = audio.first.timestamp) {
  if (capture.video.programTime !== undefined && capture.audio.programTime !== undefined) {
    const dateDelta = capture.audio.programTime - capture.video.programTime;
    return videoOrigin + dateDelta - audioOrigin;
  }
  let offset = 0;
  if (audio.format === ADTS) {
    const pts = await packedStart(audioInput);
    if (pts !== null) offset = pts - audio.first.timestamp;
    else throw new Mp4MergeError('AAC音声に映像と同期するための時刻情報がありません。');
  }
  if (video.format === MPEG_TS && (audio.format === MPEG_TS || audio.format === ADTS)) {
    offset += Math.round((videoOrigin - audioOrigin - offset) / wrapPeriod) * wrapPeriod;
  }
  return offset;
}

async function clip(video, audio, offset, live, partial) {
  let v = await video.sink.getFirstKeyPacket(), a = audio.first;
  if (!v) throw new Mp4MergeError('保存を開始できる映像のキーフレームがありません。');
  const audioStart = a.timestamp + offset;
  const commonEnd = Math.min(video.end, audio.end + offset);
  if (Math.max(v.timestamp, audioStart) >= commonEnd) throw new Mp4MergeError(noOverlap);
  // A few leading audio samples or reordered video frames are normal at the start of a rendition.
  const preroll = Math.max(0.125, 3 * v.duration, a.duration);
  if (live && audioStart > v.timestamp + preroll) {
    const preceding = await video.sink.getKeyPacket(audioStart);
    if (preceding) {
      v = preceding;
      if (preceding.timestamp + Math.max(preceding.duration, a.duration) < audioStart) {
        const next = await video.sink.getNextKeyPacket(preceding);
        if (next && next.timestamp < commonEnd) v = next;
      }
    }
    if (!v || v.timestamp >= commonEnd) throw new Mp4MergeError(noOverlap);
  }
  if (live && v.timestamp > audioStart + preroll) {
    a = await audio.sink.getPacket(v.timestamp - offset);
    if (!a) throw new Mp4MergeError(noOverlap);
  }
  const origin = Math.min(v.timestamp, a.timestamp + offset);
  const end = partial ? commonEnd : Math.max(video.end, audio.end + offset);
  return { v, a, origin, end, limit: partial ? commonEnd : Infinity };
}

async function mux(video, audio, offset, range, writer, signal, progress) {
  // The caller owns the file transaction. Only it may commit after the final cancel check.
  const target = new StreamTarget(new WritableStream({ write(chunk) { signal.throwIfAborted(); return writer.write(chunk); } }),
    { chunked: true, chunkSize: 1024 * 1024 });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  const image = new EncodedVideoPacketSource(video.codec), sound = new EncodedAudioPacketSource(audio.codec);
  output.addVideoTrack(image, { rotation: await video.track.getRotation() });
  output.addAudioTrack(sound);
  const vi = video.sink.packets(range.v), ai = audio.sink.packets(range.a);
  let videoMeta = { decoderConfig: video.decoderConfig }, audioMeta = { decoderConfig: audio.decoderConfig };
  try {
    await output.start();
    let v = (await vi.next()).value, a = (await ai.next()).value;
    let writtenVideo = 0, writtenAudio = 0, lastProgress = -1;
    let videoEnd = -Infinity, outputEnd = range.origin;
    for (;;) {
      signal.throwIfAborted();
      // End at a decode-order boundary so B-frames never lose a reference frame.
      if (v && v.timestamp >= range.limit) v = undefined;
      const audioLimit = !v && Number.isFinite(range.limit) ? Math.min(range.limit, videoEnd) : range.limit;
      if (a && a.timestamp + offset >= audioLimit) a = undefined;
      if (!v && !a) break;
      const takeVideo = v && (!a || v.timestamp <= a.timestamp + offset);
      const packet = takeVideo ? v : a;
      const timestamp = packet.timestamp + (takeVideo ? 0 : offset) - range.origin;
      outputEnd = Math.max(outputEnd, range.origin + timestamp + packet.duration);
      if (takeVideo) {
        await image.add(packet.clone({ timestamp }), videoMeta);
        videoMeta = undefined;
        videoEnd = Math.max(videoEnd, packet.timestamp + packet.duration);
        writtenVideo++;
        v = (await vi.next()).value;
      } else {
        await sound.add(packet.clone({ timestamp }), audioMeta);
        audioMeta = undefined;
        writtenAudio++;
        a = (await ai.next()).value;
      }
      const percentage = Math.min(99, Math.floor(100 * timestamp / (range.end - range.origin)));
      if (percentage > lastProgress) { lastProgress = percentage; progress(percentage / 100); }
    }
    if (!writtenVideo || !writtenAudio) throw new Mp4MergeError(noOverlap);
    image.close();
    sound.close();
    signal.throwIfAborted();
    await output.finalize();
    progress(1);
    return outputEnd - range.origin;
  } catch (error) {
    signal.throwIfAborted();
    throw classifyMergeError(error);
  } finally {
    await Promise.allSettled([vi.return(), ai.return()]);
    if (output.state === 'started') await output.cancel().catch(() => {});
  }
}

export async function preparePair(videoFile, audioFile, capture, live, signal) {
  signal.throwIfAborted();
  const videoInput = new Input({ formats: [MP4, MPEG_TS], source: new BlobSource(videoFile) });
  const audioInput = new Input({ formats: [MP4, MPEG_TS, ADTS], source: new BlobSource(audioFile) });
  const dispose = () => { videoInput.dispose(); audioInput.dispose(); };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    const format = new Mp4OutputFormat();
    const video = await inspect(videoInput, 'video', format);
    const audio = await inspect(audioInput, 'audio', format);
    const offset = await audioClockOffset(video, audio, audioInput, capture);
    const range = await clip(video, audio, offset, live, capture.partial);
    return { duration: range.end - range.origin, dispose,
      writeTo: (writer, signal, progress) => mux(video, audio, offset, range, writer, signal, progress) };
  } catch (error) { dispose(); signal.throwIfAborted(); throw classifyMergeError(error); }
  finally { signal.removeEventListener('abort', dispose); }
}
