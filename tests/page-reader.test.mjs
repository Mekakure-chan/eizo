import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const code = await readFile(new URL('../extension/page-reader.js', import.meta.url), 'utf8');
const origin = 'https://player.example', mediaOrigin = 'https://media.example';

function openReader(fetch) {
  let connect, receive, close;
  const messages = [];
  const runtime = { id: 'unit', getURL: () => 'chrome-extension://unit/', onConnect: { addListener(fn) { connect = fn; } } };
  runInNewContext(code, { chrome: { runtime }, location: { origin }, fetch, URL, AbortController, btoa });
  connect({ name: 'embedded-hls-reader', sender: { id: runtime.id, url: runtime.getURL() + 'stream.html' },
    onMessage: { addListener(fn) { receive = fn; } }, onDisconnect: { addListener(fn) { close = fn; } },
    postMessage(msg) { messages.push(msg); } });
  return { messages, send: receive, close };
}

test('the source document uses anonymous CORS and delivers a byte range only as each chunk is requested', async () => {
  const bytes = Buffer.alloc(300_000, 27);
  let options;
  const reader = openReader(async (url, init) => {
    assert.equal(url.origin, mediaOrigin);
    options = init;
    return new Response(bytes, { status: 206, headers: { 'Content-Range': 'bytes 2-300001/300002' } });
  });
  await reader.send({ type: 'open', url: mediaOrigin + '/segment', origin, mediaOrigin, range: 'bytes=2-300001' });
  assert.equal(options.mode, 'cors');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, undefined);
  assert.equal(options.referrer, undefined);
  assert.deepEqual({ ...options.headers }, { Range: 'bytes=2-300001' });
  assert.deepEqual(reader.messages.map(msg => msg.type), ['head']);
  assert.equal(reader.messages[0].headers['content-range'], 'bytes 2-300001/300002');
  for (let i = 0; i < 3; i++) await reader.send({ type: 'read' });
  assert.deepEqual(reader.messages.map(msg => msg.type), ['head', 'data', 'data', 'end']);
  assert.deepEqual(Buffer.concat(reader.messages.filter(msg => msg.type === 'data').map(msg => Buffer.from(msg.chunk, 'base64'))), bytes);
  reader.close();
  assert.equal(options.signal.aborted, true);
});

test('a different frame origin, media origin or invalid range cannot start a document request', async () => {
  for (const replacement of [{ origin: 'https://other.example' }, { url: 'https://elsewhere.example/a' }, { range: 'invalid' }]) {
    let attempts = 0;
    const reader = openReader(() => { attempts++; });
    await reader.send({ type: 'open', url: mediaOrigin + '/segment', origin, mediaOrigin, ...replacement });
    assert.equal(attempts, 0);
    assert.equal(reader.messages[0].type, 'error');
    assert.equal(!!reader.messages[0].documentLost, !!replacement.origin);
    reader.close();
  }
});
