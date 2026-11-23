const types = {
  mp4: ['video/mp4;codecs=avc1.42001E,mp4a.40.2', 'video/mp4;codecs=vp9,opus', 'video/mp4'],
  webm: ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
};
export const recordMime = ext => types[ext]?.find(value => MediaRecorder.isTypeSupported(value));
export const recordFormats = () => Object.keys(types).filter(recordMime);

export async function recordVideo(job, extension, writer, signal, stop, report) {
  const mimeType = recordMime(extension);
  if (!mimeType) throw new Error('このブラウザーで利用できる録画形式を選んでください。');
  await chrome.scripting.executeScript({ target: { tabId: job.tabId, documentIds: [job.documentId] }, files: ['recorder.js'] });
  signal.throwIfAborted();
  const port = chrome.tabs.connect(job.tabId, { documentId: job.documentId, name: 'embedded-video-record' });
  let bytes = 0, abort;
  const finish = () => port.postMessage({ type: 'stop' });
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      stop.addEventListener('abort', finish, { once: true });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        reject(new Error('動画のタブとの接続が切れたため録画を中止しました。'));
      });
      port.onMessage.addListener(async msg => {
        try {
          if (msg.type === 'error') throw new Error(msg.text);
          if (msg.type === 'end') { resolve(bytes); return; }
          if (msg.type === 'state') { report(msg.text, null); return; }
          if (msg.type !== 'data' || signal.aborted) return;
          const chunk = Uint8Array.from(atob(msg.b64), c => c.charCodeAt(0));
          await writer.write(chunk);
          bytes += chunk.length;
          const received = (bytes / 1048576).toFixed(1) + ' MiB';
          report('録画中 · ' + received, null, { progressDetail: received });
          port.postMessage({ type: 'ack' });
        } catch (error) { reject(error); }
      });
      port.postMessage({ type: 'start', id: job.id, mimeType });
      if (stop.aborted) finish();
    });
  } finally {
    signal.removeEventListener('abort', abort);
    stop.removeEventListener('abort', finish);
    port.disconnect();
  }
}
