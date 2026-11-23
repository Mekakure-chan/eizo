import { httpUrl } from './media.mjs';

const services = {
  youtube: { label: 'YouTube', id: /^[A-Za-z0-9_-]{11}$/ },
  niconico: { label: 'ニコニコ動画', id: /^(?:(?:sm|so|nm)[1-9]\d{0,12}|[1-9]\d{5,12})$/ },
  dailymotion: { label: 'Dailymotion', id: /^x[a-z0-9]{3,14}$/ },
  vimeo: { label: 'Vimeo', id: /^[1-9]\d{0,11}$/ }
};

export function wholeVideo(value) {
  const url = httpUrl(value);
  if (!url || url.port) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let provider, id;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com', 'youtu.be'].includes(host)) {
    provider = 'youtube';
    if (host === 'youtu.be') id = parts[0];
    else if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1];
  } else if (['www.nicovideo.jp', 'nicovideo.jp', 'sp.nicovideo.jp', 'embed.nicovideo.jp', 'nico.ms'].includes(host)) {
    provider = 'niconico';
    if (host === 'nico.ms') id = parts[0];
    else if (parts[0] === 'watch') id = parts[1];
  } else if (['www.dailymotion.com', 'dailymotion.com', 'geo.dailymotion.com', 'dai.ly'].includes(host)) {
    provider = 'dailymotion';
    if (host === 'dai.ly') id = parts[0];
    else if (parts[0] === 'video') id = parts[1];
    else if (parts[0] === 'embed' && parts[1] === 'video') id = parts[2];
    else if (parts[0] === 'player' || parts[0] === 'player.html') id = url.searchParams.get('video');
    id = id?.split('_')[0];
  } else if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host)) {
    provider = 'vimeo';
    if (parts.length === 1) id = parts[0];
    else if (parts[0] === 'video') id = parts[1];
    else if (['channels', 'groups'].includes(parts[0])) id = parts.at(-1);
  }
  if (!id || !services[provider]?.id.test(id)) return null;
  return { kind: 'whole', provider, id, host: services[provider].label };
}

const nativeName = () => 'jp.embedded_video_saver.full.' + chrome.runtime.id;
export const nativePermission = { permissions: ['nativeMessaging'] };

export async function checkWholeHelper() {
  let reply;
  try { reply = await chrome.runtime.sendNativeMessage(nativeName(), { op: 'info' }); }
  catch { throw new Error('PCの保存ツールに接続できません。配布フォルダーの「Windows-Setup.cmd」を一度実行し、「やり直す」を押してください。'); }
  if (reply?.type === 'error' && reply.text) throw new Error(reply.text);
  if (reply?.type !== 'ready' || reply.protocol !== 1) {
    throw new Error('PCの保存ツールを更新してください。配布フォルダーの「Windows-Setup.cmd」を実行してからやり直してください。');
  }
}

export async function downloadWhole(job, writer, signal, onProgress) {
  signal.throwIfAborted();
  const port = chrome.runtime.connectNative(nativeName());
  let expected = 0, written = 0, busy = false, finished = false;
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => {
        try { port.postMessage({ op: 'cancel' }); } catch {}
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (!finished) reject(new Error('PCの保存ツールとの接続が切れました。セットアップを確認してやり直してください。'));
      });
      port.onMessage.addListener(async msg => {
        if (signal.aborted || finished) return;
        try {
          if (msg.type === 'error') throw new Error(msg.text);
          if (msg.type === 'progress') { onProgress(msg); return; }
          if (msg.type === 'file') {
            if (expected || !Number.isSafeInteger(msg.bytes) || msg.bytes < 1) throw new Error('受信したファイルのサイズが不正です。');
            expected = msg.bytes;
            onProgress({ stage: 'write', percent: 0 });
          } else if (msg.type === 'data') {
            if (!expected || busy || typeof msg.b64 !== 'string') throw new Error('ファイルの受信順序が不正です。');
            busy = true;
            const binary = atob(msg.b64);
            if (written + binary.length > expected) throw new Error('受信した動画が予定のサイズを超えました。');
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
            await writer.write(bytes);
            written += bytes.length;
            busy = false;
            onProgress({ stage: 'write', percent: written * 100 / expected });
            port.postMessage({ op: 'ack' });
          } else if (msg.type === 'end') {
            if (busy || !expected || written !== expected) throw new Error('動画の受信が途中で終了しました。');
            finished = true;
            resolve(msg.duration);
          } else throw new Error('PCの保存ツールから予期しない応答がありました。');
        } catch (error) {
          finished = true;
          reject(error);
        }
      });
      port.postMessage({ op: 'download', provider: job.provider, id: job.id });
    });
  } finally {
    finished = true;
    signal.removeEventListener('abort', abort);
    port.disconnect();
  }
}
