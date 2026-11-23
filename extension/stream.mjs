import { openSourceChoices, openTransfer, readJob, requireOrigins } from './jobs.mjs';
import { isSourceReadError, loadJobPlan, writeLivePlan, writePlan } from './hls.mjs';
import { safeName, timeLabel, writeMediaBlocks } from './media.mjs';
import { exportTsAsMp4 } from './mp4.mjs';
import { checkMp4FileDuration } from './mp4-duration.mjs';
import { stageFile } from './staging.mjs';
import { capturePair } from './renditions.mjs';
import { hlsFetchFor } from './page-request.mjs';
import { acquireSaveSlot, commitStatus, saveWaitText, storageSaveText } from './save-folder.mjs';

const $ = id => document.getElementById(id);
const viewId = new URLSearchParams(location.search).get('stream');
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !viewId || msg?.id !== viewId) return;
  if (msg.op === 'retry-stream' && sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) {
    if (job && !controller && !result && msg.job?.url === job.url && msg.job.sourceDoc === job.sourceDoc) {
      job = msg.job;
      sessionStorage.setItem('job', JSON.stringify(job));
      fetchResource = hlsFetchFor(job.pageSources);
      void acquire();
    }
    reply(true);
    return;
  }
  if (msg.op !== 'find-stream') return;
  chrome.tabs.getCurrent().then(tab => reply({ tabId: tab.id, windowId: tab.windowId }));
  return true;
});
let job, plan, stage, audioStage, pair, result, controller, stop, fetchResource, needed = [], ends = [];
function actions(...ids) {
  for (const id of ['grant', 'save', 'stop', 'cancel', 'retry', 'rescan', 'capture']) $(id).hidden = !ids.includes(id);
}
function say(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function progress(value) {
  const bar = $('progress');
  bar.hidden = false;
  if (value === undefined) bar.removeAttribute('value');
  else { bar.max = 1; bar.value = value; }
}
async function releaseStage() {
  pair?.dispose();
  pair = null;
  const old = [stage, audioStage].filter(Boolean);
  stage = audioStage = null;
  await Promise.allSettled(old.map(item => item.dispose()));
}
const audioLabel = () => plan?.audio ? '別配信の音声' + (plan.audioName ? '（' + plan.audioName + '）' : '') : '';

function ready() {
  const recover = result.sourceReadError && Number.isInteger(job.tabId);
  actions('save', ...(recover ? ['rescan', 'capture'] : []));
  if (recover) $('direct').hidden = true;
  $('raw').hidden = plan.extension !== 'ts';
  $('progress').hidden = true;
  const counts = plan.audio ? '映像 ' + result.video.count + ' 区間 / 音声 ' + result.audio.count + ' 区間' : result.count + ' 区間';
  const detail = timeLabel(result.duration) + ' · ' + counts + ' · ' + (result.bytes / 1048576).toFixed(1) + ' MiB';
  $('info').textContent = [plan.resolution, audioLabel(), detail].filter(Boolean).join(' · ');
  say(result.interruption ? 'ここまでの連続した区間を保存できます。 ' + result.interruption : '取得が完了しました。MP4を保存できます。', !!result.interruption);
}

async function acquire() {
  if (controller || result) return;
  controller = new AbortController();
  const { signal } = controller;
  let writer, audioWriter;
  needed = [];
  ends = [];
  actions('cancel');
  $('info').textContent = job.pageSources?.length ? '配信元が読み取りを許可したプレーヤーから取得します。完了まで元の動画タブを開いておいてください。' : '';
  $('direct').hidden = true;
  $('raw').hidden = true;
  say('プレイリストを確認しています…');
  try {
    plan = await loadJobPlan(job, requireOrigins, signal, fetchResource);
    $('heading').textContent = plan.live ? 'HLSライブを取得' : 'HLSアーカイブを取得';
    document.title = $('heading').textContent + ' · ' + job.label;
    $('info').textContent = [plan.resolution, audioLabel(), plan.live ? 'ライブ · このタブを開いておいてください' : '全編 ' + timeLabel(plan.duration),
      job.pageSources?.length ? '完了まで元の動画タブも開いておいてください' : ''].filter(Boolean).join(' · ');
    $('direct').hidden = !!plan.audio;
    stage = await stageFile();
    writer = await stage.handle.createWritable();
    signal.throwIfAborted();
    let outcome;
    if (plan.audio) {
      audioStage = await stageFile();
      audioWriter = await audioStage.handle.createWritable();
      stop = new AbortController();
      if (plan.live) actions('stop', 'cancel');
      progress(plan.live ? undefined : 0);
      say('映像と音声を取得しています…');
      outcome = await capturePair(plan, { video: writer, audio: audioWriter }, signal, stop.signal, requireOrigins, tracks => {
        if (!plan.live) progress((tracks.video.count + tracks.audio.count) / (plan.video.parts.length + plan.audio.parts.length));
        say('取得中 · 映像 ' + tracks.video.count + ' 区間 / 音声 ' + tracks.audio.count + ' 区間');
      }, fetchResource);
      await audioWriter.close();
      audioWriter = null;
    } else if (plan.live) {
      stop = new AbortController();
      actions('stop', 'cancel');
      progress();
      say('公開中の区間から取得を開始しています…');
      outcome = await writeLivePlan(plan, writer, signal, stop.signal, requireOrigins, (count, bytes, seconds) => {
        ends.push(bytes);
        say('ライブ取得中 · ' + timeLabel(seconds) + ' · ' + count + ' 区間');
      }, fetchResource);
    } else {
      progress(0);
      const bytes = await writePlan(plan, writer, signal, (count, total) => {
        ends.push(total);
        progress(count / plan.parts.length);
        say('取得中 · ' + count + ' / ' + plan.parts.length + ' 区間');
      }, requireOrigins, fetchResource);
      outcome = { bytes, duration: plan.duration, count: ends.length };
    }
    signal.throwIfAborted();
    actions('cancel');
    await writer.close();
    writer = null;
    if (plan.audio) {
      say('映像と音声の再生時刻を確認しています…');
      const { preparePair } = await import('./paired-mp4.mjs');
      const [videoFile, audioFile] = await Promise.all([stage.handle.getFile(), audioStage.handle.getFile()]);
      if (videoFile.size !== outcome.video.bytes || audioFile.size !== outcome.audio.bytes) throw new Error('取得済みのファイルサイズが一致しません。');
      pair = await preparePair(videoFile, audioFile, outcome, plan.live, signal);
      outcome.duration = pair.duration;
    } else if (!plan.live && plan.extension === 'mp4') {
      await checkMp4FileDuration(await stage.handle.getFile(), outcome.duration, signal);
    }
    signal.throwIfAborted();
    result = outcome;
    ready();
  } catch (error) {
    controller.abort();
    if (writer) await writer.abort().catch(() => {});
    if (audioWriter) await audioWriter.abort().catch(() => {});
    await releaseStage();
    $('progress').hidden = true;
    needed = error.origins || [];
    if (error.name === 'AbortError') { say('取得を中止しました。'); actions('retry'); }
    else if (needed.length) { say(error.message); actions('grant'); }
    else if (isSourceReadError(error)) {
      const sourceTab = Number.isInteger(job.tabId);
      $('info').textContent = sourceTab
        ? '元ページで映像を読み込み直すと、新しい配信URLを再検出できます。キャプチャを選ぶと、プレーヤーで再生する区間を録画できます。'
        : '元の動画ページで拡張を開いて配信を再検出するか、新しく発行されたm3u8のURLを指定してください。';
      $('direct').hidden = true;
      say(error.message, true);
      actions(...(sourceTab ? ['rescan', 'capture'] : ['retry']));
    } else {
      say(error.name === 'QuotaExceededError' ? 'Chromeの一時保存領域が足りません。ディスクの空き容量を確認してください。' : error.message, true);
      actions('retry');
      $('alternatives').open = true;
    }
  } finally { stop = controller = null; }
}

async function exportFile(ext) {
  if (controller || !result) return;
  controller = new AbortController();
  const { signal } = controller;
  let writer, releaseSlot;
  actions('cancel');
  $('raw').hidden = true;
  try {
    const output = await showSaveFilePicker({ suggestedName: safeName(job.label, ext),
      types: [{ description: ext.toUpperCase() + ' 動画', accept: { [ext === 'mp4' ? 'video/mp4' : 'video/mp2t']: ['.' + ext] } }] });
    say(saveWaitText);
    releaseSlot = await acquireSaveSlot(signal);
    signal.throwIfAborted();
    writer = await output.createWritable();
    progress(0);
    if (pair) {
      say('映像と音声をMP4にまとめてストレージに保存しています。');
      result.duration = await pair.writeTo(writer, signal, progress);
    } else {
      const file = await stage.handle.getFile();
      if (file.size !== result.bytes) throw new Error('取得済みのファイルサイズが一致しません。');
      if (plan.extension === 'ts' && ext === 'mp4') {
        say('映像と音声をMP4にまとめてストレージに保存しています。');
        await exportTsAsMp4(file, ends, result.duration, writer, signal, progress);
      } else {
        say(storageSaveText);
        await writeMediaBlocks(file, writer, signal, progress);
      }
    }
    signal.throwIfAborted();
    actions();
    say(commitStatus.text);
    await writer.close();
    writer = null;
    say('保存しました。 ' + output.name + '（' + timeLabel(result.duration) + '）');
    result = null;
    actions('retry');
    await releaseStage();
    $('progress').hidden = true;
  } catch (error) {
    if (writer) await writer.abort().catch(() => {});
    ready();
    if (error.name === 'AbortError') say('保存をキャンセルしました。取得済みの動画はこのタブから保存できます。');
    else { say(error.message, true); $('alternatives').open = true; }
  } finally { releaseSlot?.(); controller = null; }
}

$('grant').onclick = async () => {
  try {
    if (await chrome.permissions.request({ origins: needed })) await acquire();
    else say('配信元の読み取りは許可されませんでした。');
  } catch (error) { say(error.message, true); }
};
$('stop').onclick = () => { if (stop) { stop.abort(); actions('cancel'); say('取得済みの区間をまとめています…'); } };
$('cancel').onclick = () => controller?.abort();
$('retry').onclick = acquire;
$('rescan').onclick = () => openSourceChoices(job, 'recover').catch(error => say(error.message, true));
$('capture').onclick = () => openSourceChoices(job, 'capture').catch(error => say(error.message, true));
$('save').onclick = () => exportFile('mp4');
$('raw').onclick = () => exportFile('ts');
$('direct').onclick = () => openTransfer(job, 'transfer.html').catch(error => say(error.message, true));
$('options').onclick = () => openSourceChoices(job).catch(error => say(error.message, true));
addEventListener('beforeunload', event => {
  if (controller || result) { event.preventDefault(); event.returnValue = ''; }
});
addEventListener('pagehide', () => { controller?.abort(); void releaseStage(); });
addEventListener('pageshow', event => {
  if (!event.persisted || stage || !job) return;
  result = null;
  $('raw').hidden = $('progress').hidden = true;
  say('取得を再開するには「再取得」を押してください。');
  actions('retry');
});

async function initialize() {
  job = await readJob();
  if (job?.kind !== 'hls') { say('動画ページで拡張を開いて配信を選んでください。', true); return; }
  fetchResource = hlsFetchFor(job.pageSources);
  $('source').textContent = job.host;
  $('title').textContent = job.label;
  $('alternatives').hidden = false;
  $('options').hidden = !Number.isInteger(job.tabId);
  await acquire();
}
initialize().catch(error => say(error.message, true));
