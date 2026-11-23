import { isSourceReadError } from './hls.mjs';
import { acquireMedia, finishMergeFailure } from './queue-transfer.mjs';
import { dropFiles, runLock } from './queue-files.mjs';
import { readGapPreference } from './queue.mjs';
import { isUpdateModuleError } from './update-retry.mjs';

export async function acquireRun(page, controller, stop, write, {expectedPhase, skipGaps, previousFailure, readGapSetting = () => readGapPreference(page.incognito), ...options}, onError) {
  const run = page.run, phase = page.job.kind === 'record' ? 'recording' : 'fetching';
  const snapshot = { run, phase, text: '取得を開始しています…', progress: null, progressAt: Date.now(), info: '', live: false };
  let last = 0, pending;
  // Claim the requested phase once, then wait for any cleanup of the previous attempt.
  if (!await write(snapshot, expectedPhase)) return;
  await navigator.locks.request(runLock(run), async () => {
    function publishProgress() {
      clearTimeout(pending); pending = undefined; last = Date.now();
      void write({ ...snapshot }).catch(onError);
    }
    function report(text, value = snapshot.progress, extra) {
      const progress = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
      if (progress !== snapshot.progress || (extra?.progressDetail !== undefined && extra.progressDetail !== snapshot.progressDetail)) {
        snapshot.progressAt = Date.now();
      }
      snapshot.text = text;
      Object.assign(snapshot, extra, { progress });
      const delay = 200 - (Date.now() - last);
      if (extra?.info !== undefined || extra?.readerMode || delay <= 0) publishProgress();
      else pending ??= setTimeout(publishProgress, delay);
    }
    try {
      await dropFiles(run);
      skipGaps = page.job.kind === 'hls' && (skipGaps || await readGapSetting());
      const output = await acquireMedia(page, { signal: controller.signal, stop: stop.signal, ...options, skipGaps, previousFailure, report });
      clearTimeout(pending);
      const text = output.omittedRanges?.length ? '欠損区間を除いて取得しました。動画を保存できます。' :
        output.interruption ? '取得できた区間を保存できます。 ' + output.interruption : '取得が完了しました。動画を保存できます。';
      await write({ phase: 'ready', text, progress: null, output, sourceProblem: output.sourceReadError });
    } catch (error) {
      clearTimeout(pending);
      controller.abort();
      if (await finishMergeFailure(run,error,snapshot.omittedRanges,next => write(next,'fetching'))) return;
      await dropFiles(run).catch(() => {});
      const permission = error.permission || (error.origins?.length ? { origins: error.origins } : null);
      const phase = permission ? 'permission' : error.name === 'AbortError' ? 'canceled' : 'failed';
      const text = phase === 'canceled' ? '取得を中止しました。' : error.name === 'QuotaExceededError'
        ? '一時保存領域が足りません。ディスクの空きを確認してから再取得してください。' : error.message;
      const lostOriginal = snapshot.readerMode === 'detached' && isSourceReadError(error);
      await write({ phase, text, progress: null, permission, sourceProblem: isSourceReadError(error),
        ...(phase === 'failed' && error.canSkip ? {canSkip:true, skipSegment:error.skipSegment ?? null} : {}),
        ...((permission || isUpdateModuleError(text)) && skipGaps ? {resumeWithGaps:true, skipSegment:previousFailure ?? null} : {}),
        readerDisconnected: !!error.readerDisconnected,
        info: lostOriginal ? '検出した元プレーヤーとの接続が切れています。元ページを開いて再検出してください。' : '' });
    }
  });
}
