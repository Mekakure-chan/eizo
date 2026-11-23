import { safeName, timeLabel } from './media.mjs';
import { openSourceChoices, openTransfer, readJob, requireOrigins } from './jobs.mjs';
import { isSourceReadError, loadJobPlan, writeLivePlan, writePlan } from './hls.mjs';
import { checkWholeHelper, downloadWhole, nativePermission } from './whole.mjs';
import { hlsFetchFor } from './page-request.mjs';
import { recordFormats, recordMime, recordVideo } from './recording.mjs';
import { acquireSaveSlot, commitStatus, saveWaitText, storageSaveText } from './save-folder.mjs';

const $ = id => document.getElementById(id);
const extensionName = chrome.runtime.getManifest().name;
let job, plan, pendingOrigins, controller, liveStop, recordStop, fetchResource, working = false;

function actions(...ids) {
  for (const id of ['grant', 'start', 'stop', 'show', 'cancel', 'retry', 'rescan', 'capture']) $(id).hidden = !ids.includes(id);
}
function say(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function handleError(error) {
  say(error.message || '保存を完了できませんでした。', true);
  if (job?.kind === 'hls' && Number.isInteger(job.tabId) && isSourceReadError(error)) {
    $('info').textContent = '元ページで動画を読み込み直して新しいURLを再検出するか、再生区間のキャプチャを選べます。';
    actions('rescan', 'capture');
    return;
  }
  actions('retry');
}
async function checkAccess(urls) {
  try { await requireOrigins(urls); }
  catch (error) { pendingOrigins = error.origins || []; throw error; }
}
async function prepare() {
  actions();
  $('progress').hidden = true;
  pendingOrigins = [];
  try {
    if (typeof showSaveFilePicker !== 'function') throw new Error('このブラウザーには保存先を選ぶ機能がありません。デスクトップ版Chromeで開いてください。');
    if (job.kind === 'whole') {
      $('info').textContent = '映像と音声を取得し、全編をMP4に保存します。保存中はこのタブを開いておいてください。元の動画タブは閉じられます。';
      $('start').textContent = '保存先を選んでダウンロード';
      if (!await chrome.permissions.contains(nativePermission)) {
        $('grant').textContent = 'PCの保存ツールとの接続を許可';
        say('初回のみ、Windowsの保存ツールとの接続を許可してください。');
        actions('grant');
        return;
      }
      say('PCの保存ツールに接続しています…');
      await checkWholeHelper();
      say('ダウンロードの準備ができました。');
      actions('start');
      return;
    }
    if (job.kind === 'record') {
      const select = $('record-format');
      const preferred = select.value;
      select.replaceChildren();
      for (const ext of recordFormats()) select.add(new Option(ext.toUpperCase(), ext));
      if (!select.length) throw new Error('このブラウザーには利用できる録画形式がありません。');
      if (preferred && recordMime(preferred)) select.value = preferred;
      $('format-label').hidden = false;
      $('info').textContent = '録画は再生位置から始まります。先頭から保存する場合は、冒頭で一時停止し、保存先を選んでから再生してください。録画中はこのタブと動画のタブを開いておいてください。';
      $('start').textContent = '保存先を選んで録画';
      say('保存形式と保存先を選ぶとキャプチャを開始できます。');
      actions('start', 'show');
      return;
    }
    say('HLSの画質と区間を確認しています…');
    plan = await loadJobPlan(job, checkAccess, undefined, fetchResource);
    if (plan.audio) {
      $('info').textContent = '映像と音声が別々の配信です。取得画面で両方を1本のMP4に保存できます。';
      $('start').textContent = '音声付きMP4の取得画面を開く';
      say('映像と音声の組み合わせを確認しました。');
      actions('start');
      return;
    }
    $('heading').textContent = plan.live ? 'HLSライブを保存' : 'HLSアーカイブを保存';
    document.title = $('heading').textContent + ' · ' + extensionName;
    $('start').textContent = plan.live ? '保存先を選んでライブ保存' : '保存先を選んで全編を保存';
    $('cancel').textContent = plan.live ? '破棄' : '中止';
    const length = (plan.live ? '現在の公開範囲 ' : '') + timeLabel(plan.duration);
    $('info').textContent = [plan.extension === 'ts' ? 'MPEG-TS（.ts）' : 'MP4（.mp4）',
      plan.resolution, length, plan.parts.length + ' 区間', job.pageSources?.length && '完了まで元の動画タブも開いておいてください'].filter(Boolean).join(' · ');
    say(plan.live ? '開始時に取得できる最も古い区間から保存します。このタブを開いておき、「停止して保存」で終了できます。'
      : '全編をダウンロードします。保存中はこのタブを開いておいてください。');
    actions('start');
  } catch (error) {
    if (pendingOrigins.length) { say(error.message); actions('grant'); }
    else handleError(error);
  }
}

async function record(writer, signal) {
  recordStop = new AbortController();
  actions('stop', 'show', 'cancel');
  try {
    return await recordVideo(job, $('record-format').value, writer, signal, recordStop.signal, text => say(text));
  } finally { recordStop = null; }
}

async function save() {
  if (working) return;
  if (plan?.audio) { await openTransfer(job).catch(handleError); return; }
  working = true;
  let writer, releaseSlot;
  const isRecord = job.kind === 'record';
  const isWhole = job.kind === 'whole';
  const ext = isWhole ? 'mp4' : isRecord ? $('record-format').value : plan.extension;
  if (isRecord) $('record-format').disabled = true;
  const mime = { ts: 'video/mp2t', mp4: 'video/mp4', webm: 'video/webm' }[ext];
  controller = new AbortController();
  const { signal } = controller;
  try {
    const handle = await showSaveFilePicker({ suggestedName: safeName(job.label, ext),
      types: [{ description: ext.toUpperCase() + ' 動画', accept: { [mime]: ['.' + ext] } }] });
    actions('cancel');
    say(saveWaitText);
    releaseSlot = await acquireSaveSlot(signal);
    signal.throwIfAborted();
    writer = await handle.createWritable();
    say(isRecord ? '動画のタブに接続しています…' : storageSaveText);
    let duration, interruption, sourceReadError;
    if (isWhole) {
      say('配信元で動画を確認しています…');
      duration = await downloadWhole(job, writer, signal, ({ stage, percent }) => {
        const bar = $('progress');
        bar.hidden = false;
        bar.max = 100;
        if (Number.isFinite(percent)) bar.value = percent;
        else bar.removeAttribute('value');
        const text = stage === 'write' ? '動画ファイルをストレージに保存中' : stage === 'verify' ? '映像・音声と長さを確認中' : '配信元から取得中';
        say(text + (Number.isFinite(percent) ? ' · ' + Math.floor(percent) + '%' : '…'));
      });
    } else if (isRecord) {
      await record(writer, signal);
    } else if (plan.live) {
      liveStop = new AbortController();
      actions('stop', 'cancel');
      const bar = $('progress');
      bar.removeAttribute('value');
      bar.hidden = false;
      say('ライブの最新の区間一覧を取得しています…');
      const result = await writeLivePlan(plan, writer, signal, liveStop.signal, checkAccess, (count, bytes, seconds) => {
        say('ライブを動画ファイルとしてストレージに保存中 · ' + timeLabel(seconds) + ' · ' + count + ' 区間 · ' + (bytes / 1048576).toFixed(1) + ' MiB');
      }, fetchResource);
      duration = result.duration;
      interruption = result.interruption;
      sourceReadError = result.sourceReadError;
    } else {
      const bar = $('progress');
      bar.max = plan.parts.length;
      bar.value = 0;
      bar.hidden = false;
      await writePlan(plan, writer, signal, (count, bytes) => {
        bar.value = count;
        say(storageSaveText + ' ' + count + ' / ' + plan.parts.length + ' 区間 · ' + (bytes / 1048576).toFixed(1) + ' MiB');
      }, checkAccess, fetchResource);
      duration = plan.duration;
    }
    signal.throwIfAborted();
    actions();
    say(commitStatus.text);
    await writer.close();
    writer = null;
    $('progress').hidden = true;
    const saved = handle.name + (duration ? '（' + timeLabel(duration) + '）' : '');
    if (interruption) {
      say('取得済みの区間まで保存しました。 ' + saved + '　' + interruption, true);
      if (sourceReadError && Number.isInteger(job.tabId)) actions('rescan', 'capture');
      else actions('retry');
    } else say('保存しました。 ' + saved);
  } catch (error) {
    controller.abort();
    if (writer) await writer.abort().catch(() => {});
    $('progress').hidden = true;
    if (error.name === 'AbortError') {
      say('保存をキャンセルしました。');
      actions('start', ...(isRecord ? ['show'] : []));
    } else if (pendingOrigins?.length) {
      say(error.message);
      actions('grant');
    } else handleError(error);
  } finally {
    releaseSlot?.();
    working = false;
    if (isRecord) $('record-format').disabled = false;
    liveStop = null;
    controller = null;
  }
}

$('grant').addEventListener('click', async () => {
  try {
    const permission = job.kind === 'whole' ? nativePermission : { origins: pendingOrigins };
    if (!await chrome.permissions.request(permission)) {
      say(job.kind === 'whole' ? 'PCの保存ツールへの接続は許可されませんでした。' : '配信元の読み取りは許可されませんでした。'); return;
    }
    if (job.kind === 'whole') location.reload();
    else await prepare();
  } catch (error) { handleError(error); }
});
$('start').addEventListener('click', save);
$('rescan').onclick = () => openSourceChoices(job, 'recover').catch(error => say(error.message, true));
$('capture').onclick = () => openSourceChoices(job, 'capture').catch(error => say(error.message, true));
$('stop').addEventListener('click', () => {
  if (liveStop) { liveStop.abort(); actions('cancel'); say('取得済みの区間を保存しています…'); }
  if (recordStop) { recordStop.abort(); actions('cancel'); say('録画をファイルに保存しています…'); }
});
$('cancel').addEventListener('click', () => controller?.abort());
$('show').addEventListener('click', async () => {
  try { await chrome.tabs.update(job.tabId, { active: true }); }
  catch { say('動画のタブが閉じられています。', true); }
});
$('retry').addEventListener('click', prepare);
addEventListener('beforeunload', event => {
  if (working) { event.preventDefault(); event.returnValue = ''; }
});

async function initialize() {
  job = await readJob();
  if (!job) { say('動画ページで拡張を開き、保存する動画を選んでください。', true); return; }
  fetchResource = hlsFetchFor(job.pageSources);
  $('heading').textContent = job.kind === 'whole' ? '動画を丸ごと保存' : job.kind === 'record' ? 'キャプチャモード' : 'HLS動画を直接保存';
  document.title = $('heading').textContent + ' · ' + extensionName;
  $('title').textContent = job.label;
  $('source').textContent = job.host;
  await prepare();
}
initialize().catch(error => say(error.message, true));
