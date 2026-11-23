import { Mp4MergeError } from './mp4-merge-error.mjs';
import { checkTrackDuration, TrackTime } from './mp4-track-time.mjs';

// Queues opened with 1.6.17 can still import this name during an unpacked update.
export { checkTrackDuration };

async function checkArchiveTrack(sink, kind, expected, signal) {
  const time = new TrackTime();
  for await (const packet of sink.packets(undefined, undefined, {metadataOnly:true})) {
    signal.throwIfAborted();
    time.add(packet.timestamp, packet.duration);
  }
  time.verify(kind, expected);
}

// Check before opening the destination. Archives only need timing metadata;
// a direct MP4 also needs a readable first sample, even when its length is unknown.
export async function checkMp4FileDuration(file, expected, signal, {hlsArchive = false} = {}) {
  const knownDuration = expected > 0 && Number.isFinite(expected);
  if (hlsArchive && !knownDuration) return;
  signal.throwIfAborted();
  const { Input, MP4, BlobSource, EncodedPacketSink } = await import('./vendor/mediabunny-1.66.2.mjs');
  const input = new Input({formats:[MP4], source:new BlobSource(file, {useStreamReader:false})});
  const dispose = () => input.dispose();
  signal.addEventListener('abort', dispose, {once:true});
  try {
    signal.throwIfAborted();
    if (!hlsArchive && !await input.canRead()) throw new Error('取得したデータをMP4として読み取れませんでした。');
    const video = await input.getPrimaryVideoTrack();
    if (!hlsArchive) {
      // A direct file's displayed duration can include an intentionally silent outro.
      const track = video || await input.getPrimaryAudioTrack();
      const first = track && await new EncodedPacketSink(track).getFirstPacket();
      if (!first?.data.byteLength) throw new Error('取得したMP4に映像・音声のデータがありません。');
      if (!knownDuration) return;
      const end = await track.computeDurationOrNull();
      checkTrackDuration(video ? '映像' : 'メディア', expected, end == null ? 0 : end - await track.getFirstTimestamp());
      return;
    }
    const tracks = [video, await input.getPrimaryAudioTrack()].filter(Boolean);
    if (!tracks.length) throw new Mp4MergeError('取得したMP4に映像・音声トラックがありません。');
    await Promise.all(tracks.map(track => checkArchiveTrack(new EncodedPacketSink(track),
      track.type === 'video' ? '映像' : '音声', expected, signal)));
  } finally {
    signal.removeEventListener('abort', dispose);
    dispose();
    signal.throwIfAborted();
  }
}
