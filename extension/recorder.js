// Runs in the isolated world of the selected video document.
(() => {
  if (globalThis.embeddedVideoSaverRecorder) return;
  globalThis.embeddedVideoSaverRecorder = true;
  const busy = new WeakSet();
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'embedded-video-record' || port.sender?.id !== chrome.runtime.id) return;
    let video, stream, recorder, mimeType, ack, queue = Promise.resolve();
    let closed = false, starting = false, ownsVideo = false, buffered = 0, bytes = 0;
    const events = new AbortController();
    const on = (target, event, listener) => target.addEventListener(event, listener, { signal: events.signal });

    function cleanup() {
      if (closed) return;
      closed = true;
      events.abort();
      ack?.();
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      for (const track of stream?.getTracks() || []) track.stop();
      if (ownsVideo) busy.delete(video);
    }
    function fail(reason) {
      if (closed) return;
      port.postMessage({ type: 'error', text: reason });
      cleanup();
    }
    function asBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
    async function sendBlob(blob) {
      for (let i = 0; i < blob.size && !closed; i += 256 * 1024) {
        const b64 = await asBase64(blob.slice(i, i + 256 * 1024));
        if (closed) return;
        const written = new Promise(resolve => { ack = resolve; });
        port.postMessage({ type: 'data', b64 });
        await written;
        ack = null;
      }
      bytes += blob.size;
      buffered -= blob.size;
    }
    function finish() {
      if (!recorder) { fail('録画開始前に停止しました。'); return; }
      if (recorder.state !== 'inactive') recorder.stop();
    }
    function start() {
      if (closed || recorder) return;
      try {
        if (video.mediaKeys) throw new Error('DRMで保護された動画は録画できません。');
        stream = video.captureStream();
        if (!stream.getVideoTracks().length) throw new Error('映像を取得できません。動画を再生してから再検出してください。');
        if (!mimeType || !MediaRecorder.isTypeSupported(mimeType)) throw new Error('この録画形式を利用できません。保存画面で別の形式を選んでください。');
        recorder = new MediaRecorder(stream, { mimeType });
        on(recorder, 'dataavailable', ({ data }) => {
          if (!data.size) return;
          buffered += data.size;
          if (buffered > 32 * 1024 * 1024) { fail('ディスクへの書き込みが録画に追いつかず、中止しました。'); return; }
          queue = queue.then(() => sendBlob(data)).catch(() => fail('録画データを転送できませんでした。'));
        });
        on(recorder, 'error', () => fail('ブラウザーがこの動画の録画を終了しました。'));
        on(recorder, 'stop', async () => {
          await queue;
          if (closed) return;
          if (!bytes) { fail('録画できる映像がありませんでした。'); return; }
          port.postMessage({ type: 'end' });
          cleanup();
        });
        on(video, 'pause', () => {
          if (!video.ended && recorder.state === 'recording') {
            recorder.pause();
            port.postMessage({ type: 'state', text: '一時停止中です。動画の再生を再開すると録画も続きます。' });
          }
        });
        on(video, 'playing', () => {
          if (recorder.state === 'paused') {
            recorder.resume();
            port.postMessage({ type: 'state', text: '録画中です。動画の終了時、または手動で停止した時点まで録画します。' });
          }
        });
        on(video, 'ended', finish);
        on(video, 'emptied', finish);
        recorder.start(1000);
        port.postMessage({ type: 'state', text: '録画中です。動画の終了時、または手動で停止した時点まで録画します。' });
      } catch (error) {
        fail(error.name === 'SecurityError' ? 'この配信元の映像はブラウザーの保護により録画できません。' : error.message);
      }
    }
    function select(id) {
      video = globalThis.embeddedVideoSaverTargets?.elements.get(id);
      if (!video?.isConnected) { fail('動画が切り替わりました。動画ページで再検出してください。'); return; }
      if (busy.has(video)) { fail('この動画は別の保存画面で録画中です。'); return; }
      if (video.mediaKeys) { fail('DRMで保護された動画は録画できません。'); return; }
      busy.add(video);
      ownsVideo = true;
      on(video, 'error', () => fail('元の動画で再生エラーが発生したため録画を中止しました。'));
      on(video, 'encrypted', () => fail('暗号化された映像を検出したため録画を中止しました。'));
      on(video, 'waitingforkey', () => fail('保護された映像を検出したため録画を中止しました。'));
      if (video.paused || video.ended || video.readyState < 2) {
        on(video, 'playing', start);
        port.postMessage({ type: 'state', text: '動画のタブで再生を開始してください。再生と同時に録画が始まります。' });
      } else start();
    }
    port.onMessage.addListener(msg => {
      if (closed) return;
      if (msg.type === 'ack') ack?.();
      else if (msg.type === 'stop') finish();
      else if (msg.type === 'start' && !starting) { starting = true; mimeType = msg.mimeType || 'video/webm'; select(msg.id); }
    });
    port.onDisconnect.addListener(cleanup);
  });
})()
