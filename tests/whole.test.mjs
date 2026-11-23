import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadWhole, wholeVideo } from '../extension/whole.mjs';

test('recognizes individual public videos in watch pages, short links, and embeds', () => {
  for (const [url, provider, id] of [
    ['https://www.youtube.com/watch?v=YE7VzlLtp-4&list=extra&t=50', 'youtube', 'YE7VzlLtp-4'],
    ['https://youtu.be/YE7VzlLtp-4?t=1', 'youtube', 'YE7VzlLtp-4'],
    ['https://www.youtube-nocookie.com/embed/YE7VzlLtp-4', 'youtube', 'YE7VzlLtp-4'],
    ['https://m.youtube.com/shorts/YE7VzlLtp-4', 'youtube', 'YE7VzlLtp-4'],
    ['https://embed.nicovideo.jp/watch/sm22312215', 'niconico', 'sm22312215'],
    ['https://nico.ms/sm22312215', 'niconico', 'sm22312215'],
    ['https://geo.dailymotion.com/player/x8lr5.html?video=x84sh87', 'dailymotion', 'x84sh87'],
    ['https://www.dailymotion.com/video/x84sh87_title', 'dailymotion', 'x84sh87'],
    ['https://player.vimeo.com/video/1084537', 'vimeo', '1084537']
  ]) {
    const target = wholeVideo(url);
    assert.deepEqual([target.provider, target.id], [provider, id]);
    assert.equal('url' in target, false);
  }
  for (const url of ['https://www.youtube.com/playlist?list=123', 'https://youtube.com.evil.test/watch?v=YE7VzlLtp-4',
    'https://youtube.com:8181/watch?v=YE7VzlLtp-4', 'https://u:p@vimeo.com/12345', 'https://vimeo.com/channels/',
    'https://youtube.com/watch?v=..%2Fbad', 'https://geo.dailymotion.com/player/a.html?video=--foo']) {
    assert.equal(wholeVideo(url), null, url);
  }
});

function fixture(t) {
  let onMessage, onDisconnect, disconnected = false;
  const sent = [];
  const port = {
    onMessage: { addListener(fn) { onMessage = fn; } },
    onDisconnect: { addListener(fn) { onDisconnect = fn; } },
    postMessage(msg) { sent.push(msg); },
    disconnect() { disconnected = true; }
  };
  const old = globalThis.chrome;
  globalThis.chrome = { runtime: { id: 'a'.repeat(32), connectNative(name) {
    assert.equal(name, 'jp.embedded_video_saver.full.' + 'a'.repeat(32));
    return port;
  } } };
  t.after(() => { if (old === undefined) delete globalThis.chrome; else globalThis.chrome = old; });
  const abort = new AbortController();
  const bytes = [];
  const result = downloadWhole(wholeVideo('https://vimeo.com/1084537'),
    { async write(chunk) { bytes.push(...chunk); } }, abort.signal, () => {});
  return { sent, bytes, abort, result, message: msg => onMessage(msg), lost: () => onDisconnect(), closed: () => disconnected };
}

test('acknowledges each disk write and completes only at the announced size', async t => {
  const io = fixture(t);
  assert.deepEqual(io.sent[0], { op: 'download', provider: 'vimeo', id: '1084537' });
  await io.message({ type: 'file', bytes: 3 });
  await io.message({ type: 'data', b64: 'AQID' });
  assert.deepEqual(io.sent[1], { op: 'ack' });
  assert.deepEqual(io.bytes, [1, 2, 3]);
  await io.message({ type: 'end', duration: 15 });
  assert.equal(await io.result, 15);
  assert.equal(io.closed(), true);
});

test('truncated native output cannot be committed', async t => {
  const io = fixture(t);
  const failed = assert.rejects(io.result, /途中/);
  await io.message({ type: 'file', bytes: 4 });
  await io.message({ type: 'data', b64: 'AQID' });
  await io.message({ type: 'end', duration: 15 });
  await failed;
  assert.equal(io.closed(), true);
});

test('cancel notifies the helper and disconnects', async t => {
  const io = fixture(t);
  const failed = assert.rejects(io.result, { name: 'AbortError' });
  io.abort.abort();
  await failed;
  assert.equal(io.sent.at(-1).op, 'cancel');
  assert.equal(io.closed(), true);
});
