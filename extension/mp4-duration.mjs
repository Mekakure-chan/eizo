import { timeLabel } from './media.mjs';
import { Mp4MergeError } from './mp4-merge-error.mjs';

export function checkTrackDuration(kind, expected, actual) {
  if (!(expected > 0) || !Number.isFinite(expected)) return;
  // Match the Windows helper's tolerance for segment rounding and audio priming.
  const tolerance = Math.max(2, Math.min(10, expected * .01));
  if (!Number.isFinite(actual) || actual <= 0 || actual < expected - tolerance) {
    const length = Number.isFinite(actual) ? timeLabel(Math.max(0, actual)) : '不明';
    throw new Mp4MergeError(kind + 'の長さが足りません（予定 ' + timeLabel(expected) + '、取得できた長さ ' + length + '）。');
  }
}

// Check the staged file, before the destination is opened. A long audio track
// or a duration in the movie header alone cannot establish the length of the video.
export async function checkMp4FileDuration(file, expected, signal) {
  if (!(expected > 0) || !Number.isFinite(expected)) return;
  signal.throwIfAborted();
  const { Input, MP4, BlobSource } = await import('./vendor/mediabunny-1.66.2.mjs');
  const input = new Input({formats:[MP4], source:new BlobSource(file)});
  const dispose = () => input.dispose();
  signal.addEventListener('abort', dispose, {once:true});
  try {
    signal.throwIfAborted();
    const video = await input.getPrimaryVideoTrack(), track = video || await input.getPrimaryAudioTrack();
    const end = track && await track.computeDurationOrNull();
    const length = end == null ? 0 : end - await track.getFirstTimestamp();
    checkTrackDuration(video ? '映像' : 'メディア', expected, length);
  } finally {
    signal.removeEventListener('abort', dispose);
    dispose();
    signal.throwIfAborted();
  }
}
