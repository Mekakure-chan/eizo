import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { playlistResponse, rememberStream } from '../extension/discovery.mjs';
import { commonMaster } from '../extension/hls.mjs';

test('detects a playlist by response MIME or path and keeps only its document and URL', () => {
  const request = { tabId: 5, frameId: 2, documentId: 'frame-a', method: 'GET', statusCode: 200,
    initiator: 'https://player.example', url: 'https://cdn.example/manifest?sig=a%2Fb',
    responseHeaders: [{ name: 'Content-Type', value: 'Application/Vnd.Apple.MpegURL; charset=utf-8' }] };
  assert.deepEqual(playlistResponse(request), { url: request.url, frameId: 2, documentId: 'frame-a' });
  assert.equal(playlistResponse({ ...request, responseHeaders: [], url: 'https://cdn.example/a.M3U8#start' }).url, 'https://cdn.example/a.M3U8');
  const reload = request.url + '&_HLS_msn=17&_HLS_part=3&_HLS_skip=YES&channel=2';
  assert.equal(playlistResponse({ ...request, url: reload }).url, request.url + '&channel=2');
  for (const changes of [{ tabId: -1 }, { method: 'POST' }, { statusCode: 403 }, { responseHeaders: [] },
    { url: 'file:///private.m3u8' }, { initiator: 'chrome-extension://id' }]) {
    assert.equal(playlistResponse({ ...request, ...changes }), null);
  }
});

test('repeated fetches are one detection and the first observed playlist survives the tab limit', () => {
  const item = { url: 'https://cdn.example/master.m3u8', frameId: 0, documentId: 'a' };
  let entries = rememberStream([], item);
  assert.equal(rememberStream(entries, { ...item }), entries);
  for (let n = 0; n < 42; n++) entries = rememberStream(entries, { ...item, url: item.url + '?variant=' + n });
  assert.equal(entries.length, 32);
  assert.equal(entries[0].url, item.url);
  assert.ok(entries.at(-1).url.endsWith('41'));
});

test('places a successful same-origin, wildcard or specifically permitted playlist in its real document', () => {
  const req = { tabId: 4, frameId: 2, documentId: 'current-frame', method: 'GET', statusCode: 200,
    initiator: 'https://player.example', url: 'https://media.example/playlist.m3u8' };
  const observe = (value, changes = {}) => playlistResponse({ ...req, ...changes,
    responseHeaders: [{ name: 'Access-Control-Allow-Origin', value }] });
  assert.equal(observe(req.initiator).pageOrigin, req.initiator);
  assert.equal(observe('*').pageOrigin, req.initiator);
  assert.equal(playlistResponse({ ...req, url: req.initiator + '/video.m3u8' }).pageOrigin, req.initiator);
  assert.equal(playlistResponse({ ...req, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' },
    { name: 'Access-Control-Allow-Origin', value: req.initiator }] }).pageOrigin, undefined);
  for (const value of ['null', 'https://other.example', req.initiator + '.bad']) assert.equal(observe(value).pageOrigin, undefined);
  assert.equal(observe(req.initiator, { documentId: undefined }).pageOrigin, undefined);
  assert.equal(observe(req.initiator, { statusCode: 403 }), null);
  const first = observe('null'), latest = observe(req.initiator);
  assert.equal(rememberStream([first], latest)[0].pageOrigin, req.initiator);
  assert.equal(rememberStream([latest], first)[0].pageOrigin, undefined);
});

test('only groups observed playlists covered by one actual master', async t => {
  const server = createServer((req, res) => {
    res.end(req.url === '/master' ? '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",URI="sound"\n#EXT-X-STREAM-INF:BANDWIDTH=10\nlow\n#EXT-X-STREAM-INF:BANDWIDTH=25,AUDIO="g"\nhigh'
      : '#EXTM3U\n#EXTINF:1,\nsample.ts\n#EXT-X-ENDLIST');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const master = base + 'master', high = base + 'high';
  const allow = async () => {};
  assert.equal(await commonMaster([high, master, base + 'low'], allow), master);
  assert.equal(await commonMaster([high, base + 'sound', master], allow), master);
  assert.equal(await commonMaster([high, master, base + 'other'], allow), null);
});
