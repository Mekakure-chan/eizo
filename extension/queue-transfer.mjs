import { loadJobPlan, writeLivePlan, writePlan } from './hls.mjs';
import { capturePair } from './renditions.mjs';
import { queuePlayer } from './queue-player.mjs';
import { requireOrigins } from './jobs.mjs';
import { safeName, timeLabel, writeMediaBlocks } from './media.mjs';
import { exportTsAsMp4 } from './mp4.mjs';
import { checkMp4FileDuration } from './mp4-duration.mjs';
import { Mp4MergeError } from './mp4-merge-compat.mjs';
import { checkWholeHelper, downloadWhole, nativePermission } from './whole.mjs';
import { recordVideo } from './recording.mjs';
import { dropFiles, getResult, missingSpool, putResult, spool } from './queue-files.mjs';

export const sizeLabel = bytes => bytes < 1048576 ? Math.ceil(bytes / 1024) + ' KiB' : (bytes / 1048576).toFixed(1) + ' MiB';
export function exportName(page, output, ext) {
  const sourceTitle = !page.manual && page.job.kind === 'hls' && page.job.sourceTitle;
  const name = safeName(sourceTitle || page.job.label || page.title, ext);
  if (output.omittedRanges?.length) return name.slice(0, -(ext.length + 1)) + '（欠損あり）.' + ext;
  return output.interruption ? name.slice(0, -(ext.length + 1)) + '（一部）.' + ext : name;
}

const mimeExtensions = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi', 'video/mpeg': 'mpeg', 'video/3gpp': '3gp', 'video/x-m4v': 'm4v' };

export function exportMime(ext) {
  if (ext === 'ts') return 'video/mp2t';
  return Object.keys(mimeExtensions).find(type => mimeExtensions[type] === ext) || 'application/octet-stream';
}

export async function finishMergeFailure(run, error, omittedRanges, writeState) {
  if (!(error instanceof Mp4MergeError)) return false;
  const state = {phase:'mergeFailed', text:error.message, progress:null};
  if (omittedRanges?.length) state.omittedRanges = omittedRanges;
  if (await writeState(state)) await dropFiles(run).catch(() => {});
  return true;
}

async function direct(job, writer, signal, report, authorize) {
  await authorize([job.url]);
  const response = await fetch(job.url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal });
  try {
    if (!response.ok || !response.body) throw new Error('動画ファイルを取得できませんでした（HTTP ' + response.status + '）。');
    await authorize([response.url]);
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (type?.startsWith('text/') || type === 'application/json') throw new Error('配信元から動画ファイルが返りませんでした。');
    let expected = Number(response.headers.get('content-length'));
    if (response.status === 206) {
      const range = /^bytes 0-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
      const total = range && Number(range[2]);
      if (!Number.isSafeInteger(total) || total < 1 || Number(range[1]) !== total - 1 || (expected && expected !== total)) {
        throw new Error('配信元から動画の一部しか返らず、ファイル全体を確認できませんでした。');
      }
      expected = total;
    }
    const length = !response.headers.get('content-encoding') && expected;
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
        bytes += value.byteLength;
        const received = sizeLabel(bytes);
        report(received + (length ? ' / ' + sizeLabel(length) : ' 取得済み'), length ? bytes / length : null,
          length ? undefined : { progressDetail: received });
      }
    } finally { reader.releaseLock(); }
    if (!bytes || (length && length !== bytes)) throw new Error('動画の受信が途中で終了しました。');
    return { extension: job.extension || mimeExtensions[type] || 'bin', bytes, duration: job.duration || 0 };
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
}

async function readFile(run, name, bytes) {
  try {
    const file = await (await spool(run, name)).getFile();
    if (file.size !== bytes) throw missingSpool();
    return file;
  } catch (error) {
    if (error.name === 'NotFoundError') throw missingSpool();
    throw error;
  }
}

async function openPair(run, result, signal) {
  const { preparePair } = await import('./paired-mp4.mjs');
  const [video, audio] = await Promise.all([
    readFile(run, 'video', result.video.bytes), readFile(run, 'audio', result.audio.bytes)
  ]);
  return preparePair(video, audio, result, result.live, signal);
}

function gapClock(time) {
  const ms = Math.round(Math.max(0,time) * 1000);
  const fraction = String(ms % 1000).padStart(3,'0').replace(/0+$/,'');
  return timeLabel(Math.floor(ms / 1000)) + (fraction ? '.' + fraction : '');
}

function archiveResult(output, tracks) {
  if (!tracks) return output;
  const omittedRanges = [];
  for (const [kind, track] of Object.entries(tracks)) {
    const parts = track.segments;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].byteEnd !== parts[i].byteStart) continue;
      const first = i;
      while (i + 1 < parts.length && parts[i+1].byteEnd === parts[i+1].byteStart) i++;
      const numbers = first === i ? String(i+1) : (first+1) + '〜' + (i+1);
      omittedRanges.push((kind === 'video' ? '映像 ' : '音声 ') + numbers + '/' + parts.length + ' 区間目（' +
        gapClock(parts[first].start) + '〜' + gapClock(parts[i].end) + '）');
    }
  }
  return omittedRanges.length ? {kind:'gapped', extension:'mp4', bytes:output.bytes, tracks, omittedRanges,
    sourceDuration:tracks.video.segments.at(-1).end} : output;
}

async function openGapped(run, result, signal) {
  const { prepareGappedMp4 } = await import('./gapped-mp4.mjs');
  const tracks = result.tracks;
  const [video, audio] = await Promise.all(['video','audio'].map(kind =>
    tracks[kind] ? readFile(run,kind,tracks[kind].segments.at(-1).byteEnd) : null));
  return prepareGappedMp4(video, audio, tracks, signal);
}

async function acquireHls(run, job, writer, signal, stop, report, fetchResource, authorize, skipGaps, previousFailure) {
  const plan = await loadJobPlan(job, authorize, signal, fetchResource, skipGaps);
  const tracks = skipGaps && !plan.live ? {video:{segments:[]}} : null;
  const extra = [plan.resolution, plan.audioName, plan.live ? 'ライブ' : timeLabel(plan.duration)].filter(Boolean).join(' · ');
  report('配信を取得しています…', plan.live ? null : 0, { info: extra, live: plan.live, progressDetail: plan.live ? '0区間' : '' });
  if (plan.audio) {
    if (tracks) tracks.audio = {segments:[]};
    const audio = await (await spool(run, 'audio', true)).createWritable();
    try {
      const outcome = await capturePair(plan, { video: writer, audio }, signal, stop, authorize, current => {
        const count = current.video.count + current.audio.count;
        report('映像 ' + current.video.count + ' 区間 / 音声 ' + current.audio.count + ' 区間',
          plan.live ? null : count / (plan.video.parts.length + plan.audio.parts.length), plan.live ? { progressDetail: count + '区間' } : undefined);
      }, fetchResource, tracks, previousFailure);
      await audio.close();
      return archiveResult({ ...outcome, kind: 'pair', extension: 'mp4', live: plan.live }, tracks);
    } catch (error) { await audio.abort().catch(() => {}); throw error; }
  }
  const ends = [];
  const update = (count, bytes, duration) => {
    if (plan.extension === 'ts') ends.push(bytes);
    report((plan.live ? timeLabel(duration) + ' · ' + count : count + ' / ' + plan.parts.length) + ' 区間 · ' + sizeLabel(bytes),
      plan.live ? null : count / plan.parts.length, plan.live ? { progressDetail: count + '区間' } : undefined);
  };
  let outcome;
  if (plan.live) outcome = await writeLivePlan(plan, writer, signal, stop, authorize, update, fetchResource);
  else outcome = { bytes: await writePlan(plan, writer, signal, update, authorize, fetchResource, tracks?.video, previousFailure),
    duration: plan.duration, count: plan.parts.length };
  return archiveResult({ ...outcome, kind: plan.extension === 'ts' ? 'ts' : 'file', extension: 'mp4', live:plan.live, ends }, tracks);
}

export async function acquireMedia(page, { signal, stop, report, recordFormat, skipGaps = false, previousFailure, openPlayer = queuePlayer, authorize = requireOrigins }) {
  const { job, run } = page;
  if (job.kind === 'whole') {
    if (!await chrome.permissions.contains(nativePermission)) {
      const error = new Error('初回のみ、PCの保存ツールとの接続を許可してください。');
      error.permission = nativePermission;
      throw error;
    }
    await checkWholeHelper();
  }
  const handle = await spool(run, 'video', true);
  const writer = await handle.createWritable();
  try {
    let result;
    if (job.kind === 'hls') {
      const player = await openPlayer(job, signal, report);
      try { result = await acquireHls(run, job, writer, signal, stop, report, player.fetchResource, authorize, skipGaps, previousFailure); }
      finally { await player.dispose(); }
    }
    else if (job.kind === 'file') result = await direct(job, writer, signal, report, authorize);
    else if (job.kind === 'record') {
      const bytes = await recordVideo(job, recordFormat, writer, signal, stop, report);
      result = { extension: recordFormat, bytes };
    } else {
      const duration = await downloadWhole(job, writer, signal, ({ stage, percent }) => {
        const text = stage === 'write' ? '一時領域に書き込み中' : stage === 'verify' ? '映像と音声を確認中' : '配信元から取得中';
        report(text, Number.isFinite(percent) ? percent / 100 : null);
      });
      result = { extension: 'mp4', duration };
    }
    signal.throwIfAborted();
    await writer.close();
    if (result.kind === 'gapped') {
      report('欠損区間の前後をつなぐ再生時刻を確認しています…', null, {omittedRanges:result.omittedRanges});
      const cut = await openGapped(run,result,signal);
      try {
        result.duration = cut.duration;
        for (const gap of cut.omitted || []) {
          result.omittedRanges.push('再生できる位置までの調整（' + gapClock(gap.start) + '〜' + gapClock(gap.end) + '）');
        }
      }
      finally { cut.dispose(); }
    } else if (result.kind === 'pair') {
      report('映像と音声の再生時刻を確認しています…', null);
      const pair = await openPair(run, result, signal);
      try { result.duration = pair.duration; } finally { pair.dispose(); }
    } else {
      const file = await handle.getFile(), size = file.size;
      if (!size || (result.bytes !== undefined && result.bytes !== size)) throw new Error('取得した動画データが不完全です。');
      if (!result.live && (result.kind === 'file' || job.kind === 'file') && result.extension === 'mp4') {
        await checkMp4FileDuration(file, result.duration, signal, {hlsArchive:job.kind === 'hls'});
      }
      result.bytes = size;
    }
    await putResult(run, result);
    signal.throwIfAborted();
    return { extension: result.extension, raw: result.kind === 'ts', bytes: result.bytes, duration: result.duration || 0,
      interruption: result.interruption || '', sourceReadError: !!result.sourceReadError,
      ...(result.omittedRanges ? {omittedRanges:result.omittedRanges, sourceDuration:result.sourceDuration} : {}) };
  } catch (error) { await writer.abort().catch(() => {}); throw error; }
}

export async function openExport(run, ext) {
  const result = await getResult(run);
  if (result.kind === 'gapped' || result.kind === 'pair') {
    return { async writeTo(writer, signal, progress) {
      const pair = result.kind === 'gapped' ? await openGapped(run, result, signal) : await openPair(run, result, signal);
      try { return await pair.writeTo(writer, signal, progress); } finally { pair.dispose(); }
    } };
  }
  const file = await readFile(run, 'video', result.bytes);
  if (result.kind === 'ts' && ext === 'mp4') {
    return { writeTo: (writer,signal,progress) => exportTsAsMp4(file,result.ends,result.duration,writer,signal,progress) };
  }
  return { file, writeTo: (writer,signal,progress) => writeMediaBlocks(file,writer,signal,progress) };
}

export async function exportMedia(run, ext, writer, signal, progress) {
  const output = await openExport(run,ext);
  return output.writeTo(writer,signal,progress);
}
