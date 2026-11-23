import { writeLivePlan, writePlan } from './hls.mjs';

// Sequence numbers and segment boundaries belong to an individual rendition.
export async function capturePair(plan, writers, signal, stopSignal, checkAccess, progress, fetchResource, gapTracks, previousFailure) {
  const cancel = new AbortController();
  const finish = new AbortController();
  const onCancel = () => cancel.abort(signal.reason);
  const onStop = () => finish.abort();
  signal.addEventListener('abort', onCancel);
  stopSignal.addEventListener('abort', onStop);
  if (signal.aborted) onCancel();
  if (stopSignal.aborted) onStop();
  const tracks = { video: { count: 0, bytes: 0, duration: 0 }, audio: { count: 0, bytes: 0, duration: 0 } };
  let failure;
  async function capture(kind) {
    const source = plan[kind], track = tracks[kind];
    const report = (count, bytes, duration, part) => {
      // A date can first appear after the initial segment of a live window.
      if (track.programTime === undefined && part.programTime !== undefined) {
        track.programTime = part.programTime - track.duration;
      }
      Object.assign(track, { count, bytes, duration });
      progress(tracks);
    };
    try {
      if (plan.live) {
        const outcome = await writeLivePlan(source, writers[kind], cancel.signal, finish.signal, checkAccess, report, fetchResource);
        if (outcome.interruption) {
          track.interruption = (kind === 'video' ? '映像 · ' : '音声 · ') + outcome.interruption;
          track.sourceReadError = outcome.sourceReadError;
          finish.abort();
        }
      } else {
        await writePlan(source, writers[kind], cancel.signal, report, checkAccess, fetchResource, gapTracks?.[kind], previousFailure);
      }
    } catch (error) {
      if (!failure) {
        failure = error;
        cancel.abort(error);
      }
    }
  }
  try {
    await Promise.all([capture('video'), capture('audio')]);
    signal.throwIfAborted();
    if (failure) throw failure;
    return { ...tracks, partial: finish.signal.aborted, sourceReadError: tracks.video.sourceReadError || tracks.audio.sourceReadError,
      bytes: tracks.video.bytes + tracks.audio.bytes,
      count: tracks.video.count + tracks.audio.count, interruption: tracks.video.interruption || tracks.audio.interruption };
  } finally {
    signal.removeEventListener('abort', onCancel);
    stopSignal.removeEventListener('abort', onStop);
  }
}
