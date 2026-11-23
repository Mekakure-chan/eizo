import { timeLabel } from './media.mjs';
import { Mp4MergeError } from './mp4-merge-error.mjs';

export function checkTrackDuration(kind, expected, samples, span = samples, longestGap = 0) {
  if (!(expected > 0) || !Number.isFinite(expected)) return;
  // Match the Windows helper's tolerance for segment rounding and audio priming.
  const tolerance = Math.max(2, Math.min(10, expected * .01));
  const actual = Math.min(samples, span);
  if (!Number.isFinite(actual) || actual <= 0 || actual < expected - tolerance) {
    const length = Number.isFinite(actual) ? timeLabel(Math.max(0, actual)) : '不明';
    throw new Mp4MergeError(kind + 'の長さが足りません（予定 ' + timeLabel(expected) + '、取得できた長さ ' + length + '）。');
  }
  // Small AAC alignment gaps can accumulate across thousands of segments. A long
  // pause requires a real jump as well as a span unaccounted for by the playlist and samples.
  if (longestGap > tolerance && span > Math.max(expected, samples) + tolerance) {
    throw new Mp4MergeError(kind + 'の再生時刻が途中で大きく飛んでいます（予定 ' + timeLabel(expected) +
      '、再生時刻の範囲 ' + timeLabel(span) + '）。');
  }
}

export class TrackTime {
  first = Infinity;
  end = -Infinity;
  samples = 0;
  longestGap = 0;

  add(start, duration) {
    if (this.end !== -Infinity) this.longestGap = Math.max(this.longestGap, start - this.end);
    this.first = Math.min(this.first, start);
    this.end = Math.max(this.end, start + duration);
    this.samples += duration;
  }

  verify(kind, expected) {
    checkTrackDuration(kind, expected, this.samples, this.end - this.first, this.longestGap);
  }
}
