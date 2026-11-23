import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadJobPlan, loadPlan, parsePlaylist, writeLivePlan, writePlan } from '../extension/hls.mjs';
import { capturePair } from '../extension/renditions.mjs';
import { fetchDetached } from '../extension/page-request.mjs';

function playlist(sequence, lines, end = false) {
  return ['#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:' + sequence,
    ...lines, end ? '#EXT-X-ENDLIST' : ''].join('\n');
}
const segment = name => '#EXTINF:1,\n' + name;
function packet(id) {
  const data = Buffer.alloc(188 * 2, id);
  data[0] = data[188] = 0x47;
  return data;
}
function file(onWrite) {
  return {
    data: Buffer.alloc(0),
    position: 0,
    async write(chunk) {
      if (chunk.type === 'write') { this.position = chunk.position; chunk = chunk.data; }
      const end = this.position + chunk.length;
      this.data = Buffer.concat([this.data.subarray(0, this.position), chunk, this.data.subarray(end)]);
      this.position = end;
      onWrite?.(this.data);
    },
    async seek(position) { this.position = position; },
    async truncate(length) {
      this.data = this.data.subarray(0, length);
      this.position = Math.min(this.position, length);
    }
  };
}
async function fixture(t, handler) {
  const server = createServer((req, res) => handler(new URL(req.url, 'http://localhost'), res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port + '/stream.m3u8';
}
const allow = async () => {};
const signal = () => new AbortController().signal;

const mp4File = await readFile(new URL('./fixtures/video-fragments.mp4', import.meta.url));
const firstMoof = mp4File.indexOf('moof') - 4;
const initMp4 = mp4File.subarray(0, firstMoof);
const moofSize = mp4File.readUInt32BE(firstMoof);
const firstMdat = firstMoof + moofSize;
const segmentMp4 = mp4File.subarray(firstMoof, firstMdat + mp4File.readUInt32BE(firstMdat));

test('identifies rolling live, EVENT, immutable VOD and full segments in a low-latency playlist', () => {
  const url = 'https://example.org/live.m3u8';
  const live = playlist(123, ['#EXT-X-PLAYLIST-TYPE:EVENT', segment('a.ts'),
    '#EXT-X-PART:DURATION=0.2,URI="partial.ts"', '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.ts"']);
  const plan = parsePlaylist(live, url);
  assert.deepEqual([plan.live, plan.sequence, plan.targetDuration, plan.parts.length], [true, 123, 1, 1]);
  assert.equal(parsePlaylist(live.replace('TYPE:EVENT', 'TYPE:VOD'), url).live, false);
  assert.equal(parsePlaylist(live + '\n#EXT-X-ENDLIST', url).live, false);
  assert.throws(() => parsePlaylist(live.replace('SEQUENCE:123', 'SEQUENCE:-1'), url));
  assert.throws(() => parsePlaylist(live + '\n#EXT-X-SKIP:SKIPPED-SEGMENTS=5', url));
});

test('matches decoded video dimensions to one observed rendition and keeps its audio group', async t => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="screen",NAME="Screen",DEFAULT=YES,URI="screen-audio.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="large",NAME="Large",DEFAULT=YES,URI="large-audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000,RESOLUTION=1920x1080,AUDIO="large"', 'large.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=640x360,AUDIO="screen"', 'screen.m3u8?edition=1',
    '#EXT-X-STREAM-INF:BANDWIDTH=1900,RESOLUTION=640x360,AUDIO="screen"', 'second.m3u8'
  ].join('\n');
  const fetched = [];
  const url = await fixture(t, (uri, res) => {
    fetched.push(uri.pathname + uri.search);
    res.end(uri.pathname === '/stream.m3u8' ? master : playlist(0, [segment('part.ts')], true));
  });
  const playback = (...uris) => ({resolution:'640x360', urls:new Set(uris.map(uri => new URL(uri, url).href))});
  const choose = hint => loadPlan(url, allow, signal(), undefined, undefined, hint);
  const plan = await choose(playback('screen.m3u8?edition=1', 'large.m3u8'));
  assert.equal(plan.resolution, '640x360');
  assert.equal(plan.audioName, 'Screen');
  assert.deepEqual(fetched, ['/stream.m3u8','/screen.m3u8?edition=1','/screen-audio.m3u8']);
  for (const hint of [undefined, playback('screen-audio.m3u8'), playback('screen.m3u8?edition=2'),
    playback('screen.m3u8?edition=1','second.m3u8'), playback('screen.m3u8?edition=1','unrelated.m3u8')]) {
    const fallback = await choose(hint);
    assert.equal(fallback.resolution, '1920x1080');
    assert.equal(fallback.audioName, 'Large');
  }
  const source = {tabId:4, documentId:'player', playlistUrl:url};
  const child = {...source, playlistUrl:new URL('screen.m3u8?edition=1', url).href};
  const job = {url, tabId:4, playbackResolution:'640x360', pageSources:[source, child]};
  assert.equal((await loadJobPlan(job, allow)).resolution, '640x360');
  for (const other of [{...child, documentId:'another-player'}, {...child, tabId:17}]) {
    assert.equal((await loadJobPlan({...job, pageSources:[source, other]}, allow)).resolution, '1920x1080');
  }
  const legacy = {url, tabId:4, pageSources:[source, child]};
  assert.equal((await loadJobPlan(legacy, allow)).resolution, '1920x1080');
});

test('starts at the fresh window, ignores repeated segments and closes at ENDLIST', async t => {
  const windows = [[5, 6], [20, 21], [20, 21], [21, 22], [22, 23]];
  let reads = 0;
  const media = [];
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/stream.m3u8') {
      const ids = windows[Math.min(reads++, windows.length - 1)];
      res.end(playlist(ids[0], ids.map(id => segment(id + '.ts?revision=' + reads)), reads >= windows.length));
    } else {
      const id = parseInt(uri.pathname.slice(1), 10);
      media.push(id);
      res.end(packet(id));
    }
  });
  const plan = await loadPlan(url, allow);
  const writer = file();
  const result = await writeLivePlan(plan, writer, signal(), signal(), allow, () => {});
  assert.deepEqual(media, [20, 21, 22, 23]);
  assert.deepEqual(writer.data, Buffer.concat(media.map(packet)));
  assert.deepEqual(result, { duration: 4, count: 4, bytes: 4 * 376 });
});

test('stop rolls back an in-flight segment and keeps a playable segment boundary', async t => {
  const stop = new AbortController();
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/stream.m3u8') res.end(playlist(1, [segment('1.ts'), segment('2.ts')]));
    else if (uri.pathname === '/1.ts') res.end(packet(1));
    else res.write(packet(2)); // Wait for the user's stop while the segment body is still open.
  });
  const writer = file(bytes => { if (bytes.length > 376) stop.abort(); });
  const result = await writeLivePlan(await loadPlan(url, allow), writer, signal(), stop.signal, allow, () => {});
  assert.deepEqual(writer.data, packet(1));
  assert.deepEqual(result, { duration: 1, count: 1, bytes: 376, interruption: null });
});

test('a missed sliding-window segment saves only the contiguous prefix', async t => {
  let reads = 0;
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/stream.m3u8') {
      reads++;
      res.end(reads <= 2 ? playlist(10, [segment('10.ts')]) : playlist(12, [segment('12.ts')], true));
    } else res.end(packet(10));
  });
  const writer = file();
  const result = await writeLivePlan(await loadPlan(url, allow), writer, signal(), signal(), allow, () => {});
  assert.equal(result.count, 1);
  assert.match(result.interruption, /公開範囲/);
  assert.deepEqual(writer.data, packet(10));
});

test('a final window writes its good segments before a discontinuity and copies the MP4 init only once', async t => {
  let reads = 0, inits = 0;
  const init = initMp4, part = segmentMp4;
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/stream.m3u8') {
      const lines = ['#EXT-X-MAP:URI="init.mp4"', segment('a.m4s')];
      if (++reads > 2) lines.push(segment('b.m4s'), '#EXT-X-DISCONTINUITY', segment('c.m4s'));
      res.end(playlist(5, lines, reads > 2));
    } else if (uri.pathname === '/init.mp4') { inits++; res.end(init); }
    else res.end(part);
  });
  const writer = file();
  const result = await writeLivePlan(await loadPlan(url, allow), writer, signal(), signal(), allow, () => {});
  assert.equal(inits, 1);
  assert.equal(result.count, 2);
  assert.match(result.interruption, /切り替え/);
  assert.deepEqual(writer.data, Buffer.concat([init, part, part]));
});

test('transient errors retry and explicit discard remains an abort', async t => {
  let mediaReads = 0;
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/stream.m3u8') res.end(playlist(0, [segment('a.ts')]));
    else if (!mediaReads++) { res.writeHead(503); res.end(); }
    else res.end(packet(3));
  });
  const cancel = new AbortController();
  const writer = file();
  await assert.rejects(writeLivePlan(await loadPlan(url, allow), writer, cancel.signal, signal(), allow, () => cancel.abort()),
    { name: 'AbortError' });
  assert.equal(mediaReads, 2);
  assert.deepEqual(writer.data, packet(3));
});

test('an archive retries an incomplete TS packet without duplicating the earlier bytes', async t => {
  let attempts = 0;
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/stream.m3u8') res.end(playlist(20, [segment('a.ts'), segment('b.ts')], true));
    else if (uri.pathname === '/a.ts') res.end(packet(20));
    else res.end(++attempts === 1 ? packet(21).subarray(0, 255) : packet(21));
  });
  const writer = file();
  const result = await writePlan(await loadPlan(url, allow), writer, undefined, () => {}, allow);
  assert.equal(attempts, 2);
  assert.equal(result, 752);
  assert.deepEqual(writer.data, Buffer.concat([packet(20), packet(21)]));
});

test('a clean HTTP response ending in a partial MP4 box or before its media payload is retried without duplicating bytes', async t => {
  let inits = 0, segments = 0;
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/stream.m3u8') return res.end(playlist(0, ['#EXT-X-MAP:URI="init.mp4"', segment('one.m4s')], true));
    if (uri.pathname === '/init.mp4') return res.end(++inits === 1 ? initMp4.subarray(0, initMp4.readUInt32BE(0)) : initMp4);
    const attempts = [segmentMp4.subarray(0, -7), segmentMp4.subarray(0, moofSize), segmentMp4];
    res.end(attempts[segments++]);
  });
  const writer = file(), plan = await loadPlan(url, allow);
  await writePlan(plan, writer, signal(), () => {}, allow);
  assert.equal(inits, 2, 'a truncated initialization cannot pass just because it starts with ftyp');
  assert.equal(segments, 3, 'both the truncated mdat and the missing mdat must be retried');
  assert.deepEqual(writer.data, Buffer.concat([initMp4, segmentMp4]));
});

test('a live MP4 ends at the last complete segment when the next segment stays truncated', async t => {
  let attempts = 0, reads = 0;
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/stream.m3u8') return res.end(playlist(0, [
      '#EXT-X-MAP:URI="init.mp4"', segment('one.m4s'), segment('two.m4s')], ++reads > 1));
    if (uri.pathname === '/init.mp4') return res.end(initMp4);
    if (uri.pathname === '/one.m4s') return res.end(segmentMp4);
    attempts++;
    res.end(segmentMp4.subarray(0, -1));
  });
  const writer = file(), plan = await loadPlan(url, allow);
  const result = await writeLivePlan(plan, writer, signal(), signal(), allow, () => {});
  assert.equal(result.count, 1);
  assert.equal(attempts, 3);
  assert.match(result.interruption, /不完全|途中|不足/);
  assert.deepEqual(writer.data, Buffer.concat([initMp4, segmentMp4]));
});

test('an unbounded mdat ends at its own HLS segment when two fragments are joined', async () => {
  const base = 'http://localhost/stream.m3u8';
  const plan = parsePlaylist(playlist(0, ['#EXT-X-MAP:URI="init.mp4"', segment('a.m4s'), segment('b.m4s')], true), base);
  const openEnded = Buffer.from(segmentMp4);
  openEnded.writeUInt32BE(0, moofSize);
  const extendedFree = Buffer.alloc(19);
  extendedFree.writeUInt32BE(1);
  extendedFree.write('free', 4);
  extendedFree.writeBigUInt64BE(19n, 8);
  const first = Buffer.concat([extendedFree, openEnded]);
  const writer = file();
  await writePlan(plan, writer, signal(), () => {}, allow, async url => {
    const bytes = url.endsWith('init.mp4') ? initMp4 : url.endsWith('a.m4s') ? first : segmentMp4;
    const body = new ReadableStream({
      start(controller) {
        // Deliberately split even 8-byte and 16-byte headers across multiple network reads.
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
        controller.close();
      }
    });
    return {url, ok:true, status:200, headers:new Headers(), body};
  });
  assert.deepEqual(writer.data, Buffer.concat([initMp4, extendedFree, segmentMp4, segmentMp4]));
});

test('a final open-ended MP4 box larger than its size field stays valid and cannot swallow a subsequent segment', async () => {
  const base = 'http://localhost/large.m3u8';
  const first = Buffer.from(segmentMp4);
  first.writeUInt32BE(0, moofSize);
  const payload = new Uint8Array(4 * 1024 * 1024); // Reuse one chunk; the writer only counts bytes.
  const fetchPart = async url => {
    let blocks = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (url.endsWith('init.mp4')) { controller.enqueue(initMp4); controller.close(); return; }
        if (blocks === 0) controller.enqueue(first);
        else controller.enqueue(payload);
        if (++blocks === 1025) controller.close();
      }
    });
    return {url, ok:true, status:200, headers:new Headers(), body};
  };
  const writer = {async write(chunk) { assert.ok(ArrayBuffer.isView(chunk)); }, async truncate() {}};
  const lines = ['#EXT-X-MAP:URI="init.mp4"', segment('huge.m4s')];
  const run = parts => writePlan(parsePlaylist(playlist(0, parts, true), base), writer, signal(), () => {}, allow, fetchPart);
  assert.equal(await run(lines), initMp4.length + first.length + 2 ** 32);
  await assert.rejects(run([...lines, segment('next.m4s')]), /次の区間を連結できません/);
});

test('separate renditions keep independent URLs, segment counts, sequences and timing anchors', async t => {
  const audio = playlist(92, ['#EXTINF:2,\na.ts', '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:02Z', segment('b.ts')], true);
  const video = playlist(11, [segment('1.ts'), segment('2.ts'), segment('3.ts')], true);
  const url = await fixture(t, (uri, res) => {
    const paths = {
      '/stream.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",DEFAULT=YES,URI="sound.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=32,AUDIO="g"\nvideo.m3u8',
      '/video.m3u8': video, '/sound.m3u8': audio
    };
    res.end(paths[uri.pathname] || packet(uri.pathname.charCodeAt(1)));
  });
  const checked = [];
  const plan = await loadPlan(url, async urls => checked.push(...urls));
  assert.ok(checked.includes(new URL('sound.m3u8', url).href));
  assert.deepEqual([plan.video.sequence, plan.audio.sequence, plan.live], [11, 92, false]);
  const explicit = await loadPlan(new URL('video.m3u8', url).href, allow, signal(), new URL('sound.m3u8', url).href);
  assert.equal(explicit.audio.playlistUrl, plan.audio.playlistUrl);
  const writers = { video: file(), audio: file() };
  const result = await capturePair(plan, writers, signal(), signal(), allow, () => {});
  assert.deepEqual([result.video.count, result.audio.count, result.bytes, result.partial], [3, 2, 5 * 376, false]);
  assert.equal(result.audio.programTime, Date.UTC(2026, 0, 1) / 1000);
  assert.equal(result.video.programTime, undefined);
  assert.deepEqual(writers.audio.data, Buffer.concat([packet(97), packet(98)]));
});

test('a missing audio segment fails the pair and cancels an in-flight video fetch', async t => {
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/video.m3u8') res.end(playlist(14, [segment('wait.ts')], true));
    else if (uri.pathname === '/audio.m3u8') res.end(playlist(98, [segment('failed.ts')], true));
    else if (uri.pathname === '/failed.ts') res.writeHead(403).end();
    else res.write(packet(1));
  });
  const plan = await loadPlan(new URL('video.m3u8', url).href, allow, signal(), new URL('audio.m3u8', url).href);
  await assert.rejects(capturePair(plan, { video: file(), audio: file() }, signal(), signal(), allow, () => {}), error => {
    assert.match(error.message, /音声区間.*403/);
    assert.match(error.message, /1\/1 区間目（再生位置 0:00 付近）/);
    assert.equal(error.message.split('区間目').length, 2, 'canceling the sibling track must not annotate the same error twice');
    return true;
  });
});

test('a refusal reports the HTTP status, host and failed stage without leaking the URL query', async t => {
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/media.m3u8') res.end(playlist(0, [segment('part.ts?private=example')], true));
    else res.writeHead(403).end();
  });
  const check = stage => error => {
    assert.equal(error.status, 403);
    assert.match(error.message, stage);
    assert.ok(error.message.includes(new URL(url).host));
    assert.doesNotMatch(error.message, /private|example/);
    return true;
  };
  await assert.rejects(loadPlan(url + '?private=example', allow), check(/プレイリスト/));
  const plan = await loadPlan(new URL('media.m3u8', url).href, allow);
  await assert.rejects(writePlan(plan, file(), signal(), () => {}, allow), check(/区間/));
});

test('a 403 two thirds into a VOD identifies its real playback offset and stops at that segment', async t => {
  const requests = [], durations = [8.5, 9.75, 6.5, 10, 7.25, 9.5, 6, 5, 7];
  const manifest = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:702',
    ...durations.map((seconds,i) => '#EXTINF:' + seconds + ',\npart-' + i + '.ts?private=example'), '#EXT-X-ENDLIST'].join('\n');
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/stream.m3u8') return res.end(manifest);
    requests.push(uri.pathname);
    if (uri.pathname === '/part-6.ts') return res.writeHead(403).end();
    res.end(packet(1));
  });
  const plan = await loadPlan(url, allow);
  const completed = [];
  await assert.rejects(writePlan(plan, file(), signal(), count => completed.push(count), allow), error => {
    assert.equal(error.status, 403);
    assert.match(error.message, /動画区間.*403/);
    assert.match(error.message, /7\/9 区間目（再生位置 0:51 付近）/);
    assert.doesNotMatch(error.message, /part-|private|example/);
    return true;
  });
  assert.deepEqual(completed, [1,2,3,4,5,6]);
  assert.deepEqual(requests, durations.slice(0,7).map((_,i) => '/part-' + i + '.ts'));
});

test('a refused segment of the chosen rendition stops the VOD at 26:30 without changing quality', async t => {
  const media = [], manifests = [];
  const parts = Array.from({length:627}, (_, i) => '#EXTINF:' + (i === 0 ? 6 : i === 626 ? 2 : 4) + ',\n' + (i + 1) + '.ts');
  const vod = ['#EXTM3U','#EXT-X-TARGETDURATION:6',...parts,'#EXT-X-ENDLIST'].join('\n');
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname.endsWith('.m3u8')) {
      manifests.push(uri.pathname);
      if (uri.pathname === '/stream.m3u8') {
        return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1280x720\nhigh.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nshown.m3u8');
      }
      return res.end(vod);
    }
    media.push(uri.pathname);
    if (uri.pathname === '/398.ts') return res.writeHead(403).end();
    res.end(packet(7));
  });
  const playback = {resolution:'640x360', urls:new Set([new URL('shown.m3u8', url).href])};
  const plan = await loadPlan(url, allow, signal(), undefined, undefined, playback);
  assert.equal(plan.duration, 41 * 60 + 48);
  let complete = 0, refused;
  await assert.rejects(writePlan(plan, file(), signal(), count => { complete = count; }, allow), error => {
    assert.equal(error.status, 403);
    assert.match(error.message, /398\/627 区間目（再生位置 26:30 付近）/);
    assert.match(error.message, /取得画質 640×360/);
    refused = error.skipSegment;
    return true;
  });
  assert.equal(complete, 397);
  assert.equal(media.length, 398);
  assert.equal(media.at(-1), '/398.ts');
  assert.deepEqual(manifests, ['/stream.m3u8','/shown.m3u8']);
  const trace = {segments:[]}, disk = file();
  const bytes = await writePlan(plan, disk, signal(), () => {}, allow, undefined, trace, refused);
  assert.equal(bytes, 626 * packet(7).length);
  assert.equal(trace.segments.length,627);
  const missing = trace.segments.filter(s => s.byteStart === s.byteEnd);
  assert.deepEqual(missing.map(s => [s.start,s.end]),[[1590,1594]]);
  assert.equal(media.filter(s => s === '/398.ts').length,1);
  assert.equal(media.at(-1),'/627.ts');
});

test('an opted-in archive rolls back bytes from the final truncated response before the next segment', async t => {
  let attempts = 0;
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname === '/stream.m3u8') return res.end(playlist(0,[segment('a.ts'),segment('truncated.ts'),segment('b.ts')],true));
    if (uri.pathname === '/truncated.ts') { attempts++; return res.end(packet(9).subarray(0,255)); }
    res.end(packet(uri.pathname === '/a.ts' ? 1 : 2));
  });
  const plan = await loadPlan(url,allow), disk = file(), track = {segments:[]};
  await writePlan(plan,disk,signal(),()=>{},allow,undefined,track);
  assert.equal(attempts,3);
  assert.deepEqual(disk.data,Buffer.concat([packet(1),packet(2)]));
  assert.equal(track.segments[1].byteStart,track.segments[1].byteEnd);
});

test('an opted-in archive keeps only validated parts and can omit a previously refused part without requesting it again', async t => {
  const hits = [];
  const url = await fixture(t, (uri,res) => {
    hits.push(uri.pathname);
    if (uri.pathname === '/stream.m3u8') return res.end(playlist(38,
      [segment('a.ts'), segment('denied.jpeg'), segment('bad.ts'), segment('b.ts')], true));
    if (uri.pathname === '/denied.jpeg') return res.writeHead(403).end();
    if (uri.pathname === '/bad.ts') return res.end(Buffer.alloc(400));
    res.end(packet(uri.pathname === '/a.ts' ? 1 : 2));
  });
  const plan = await loadPlan(url, allow);
  let failed;
  await assert.rejects(writePlan(plan,file(),signal(),()=>{},allow), error => {
    failed = error.skipSegment;
    return error.status === 403 && failed?.number === 2;
  });
  assert.ok(!JSON.stringify(failed).includes('denied'));
  const disk = file(), trace = {segments:[]};
  hits.length = 0;
  const bytes = await writePlan(plan,disk,signal(),()=>{},allow,undefined,trace,failed);
  assert.equal(bytes, packet(1).length * 2);
  assert.deepEqual(disk.data,Buffer.concat([packet(1),packet(2)]));
  assert.deepEqual(hits,['/a.ts','/bad.ts','/b.ts']);
  assert.deepEqual(trace.segments.map(p => [p.start,p.end,p.byteStart,p.byteEnd]),[
    [0,1,0,376],[1,2,376,376],[2,3,376,376],[3,4,376,752]]);
  const newer = {...plan, parts:plan.parts.map((part,i) => i === 1 ? {...part,url:new URL('restored.ts',url).href} : part)};
  hits.length = 0;
  await writePlan(newer,file(),signal(),()=>{},allow,undefined,{segments:[]},failed);
  assert.ok(hits.includes('/restored.ts'), 'a different advertised resource at the same ordinal is read normally');
});

test('skipping declared VOD gaps never requests them or turns a storage, login, or initialization error into a saved movie', async t => {
  const seen = [];
  const url = await fixture(t,(uri,res) => {
    seen.push(uri.pathname);
    if (uri.pathname === '/stream.m3u8') return res.end(playlist(0,['#EXT-X-GAP',segment('https://missing.example.invalid/absent'),segment('ok')],true));
    if (uri.pathname === '/init' || uri.pathname === '/login') return res.writeHead(uri.pathname === '/init' ? 403 : 401).end();
    res.end(packet(1));
  });
  await assert.rejects(loadPlan(url,allow), /欠落/);
  const plan = await loadJobPlan({url},async urls => {
    assert.ok(urls.every(address => new URL(address).host === new URL(url).host),'a declared missing segment needs no host permission');
  },signal(),undefined,true);
  const trace = {segments:[]};
  assert.equal(await writePlan(plan,file(),signal(),()=>{},allow,undefined,trace),376);
  assert.ok(!seen.includes('/absent'));
  assert.equal(trace.segments[0].byteStart,trace.segments[0].byteEnd);
  const disk = file();
  disk.write = async () => { throw new DOMException('disk full','QuotaExceededError'); };
  await assert.rejects(writePlan(plan,disk,signal(),()=>{},allow,undefined,{segments:[]}),{name:'QuotaExceededError'});
  const bad = name => ({url:new URL(name,url).href,duration:1});
  await assert.rejects(writePlan({...plan,parts:[bad('login')]},file(),signal(),()=>{},allow,undefined,{segments:[]}),
    err => err.status === 401 && !err.skipSegment);
  await assert.rejects(writePlan({...plan,init:bad('init')},file(),signal(),()=>{},allow,undefined,{segments:[]}),
    err => err.status === 403 && !err.skipSegment);
  await assert.rejects(writePlan({...plan,parts:[plan.parts[0]]},file(),signal(),()=>{},allow,undefined,{segments:[]}), /保存できる.*区間/);
});

test('after the source closes, a readable origin can have an isolated gap while a lost origin stops the archive', async t => {
  const hits = [], otherHits = [];
  const url = await fixture(t,(uri,res) => {
    hits.push(uri.pathname);
    if (uri.pathname === '/gap.ts') return res.writeHead(403).end();
    res.end(packet(uri.pathname === '/a.ts' ? 1 : 2));
  });
  const other = await fixture(t, (uri,res) => { otherHits.push(uri.pathname); res.writeHead(403).end(); });
  const plan = parts => parsePlaylist(playlist(0,parts.map(segment),true),url);
  const track = {segments:[]}, disk = file();
  await writePlan(plan(['a.ts','gap.ts','b.ts']),disk,signal(),()=>{},allow,fetchDetached,track);
  assert.deepEqual(hits,['/a.ts','/gap.ts','/b.ts']);
  assert.deepEqual(disk.data,Buffer.concat([packet(1),packet(2)]));
  assert.equal(track.segments[1].byteStart,track.segments[1].byteEnd);
  await assert.rejects(writePlan(plan([new URL('private.ts',other).href,'later.ts']),file(),signal(),()=>{},allow,fetchDetached,{segments:[]}),
    err => err.status === 403 && err.pageUnavailable && !err.canSkip);
  assert.deepEqual(otherHits,['/private.ts']);
  assert.ok(!hits.includes('/later.ts'));
});

for (const resource of ['playlist','initialization','separate audio','damaged video']) {
  test('a direct ' + resource + ' response cannot establish that the remaining video is readable', async t => {
    const hits = [];
    const videoParts = ['first.m4s', ...(resource === 'damaged video' ? ['broken.m4s'] : []), 'lost.m4s','tail.m4s'];
    const url = await fixture(t,(uri,res) => {
      hits.push(uri.pathname);
      if (uri.pathname === '/stream.m3u8') return res.end(playlist(0,['#EXT-X-MAP:URI="init.mp4"',...videoParts.map(segment)],true));
      if (uri.pathname === '/init.mp4') return res.end(initMp4);
      if (uri.pathname === '/first.m4s') return res.end(segmentMp4);
      if (uri.pathname === '/audio.ts') return res.end(packet(1));
      if (uri.pathname === '/broken.m4s') return res.end('unreadable fragment');
      res.writeHead(403).end();
    });
    const plan = await loadPlan(url,allow,signal(),undefined,resource === 'playlist' ? fetchDetached : fetch);
    if (resource === 'separate audio') {
      const audio = parsePlaylist(playlist(0,[segment('audio.ts')],true),url);
      await writePlan({...audio,audioRendition:true},file(),signal(),()=>{},allow,fetchDetached,{segments:[]});
    }
    const read = (url,options) => {
      // The first video segment was available through the original player.
      if (url.endsWith('/first.m4s') || (url.endsWith('/init.mp4') && resource !== 'initialization')) return fetch(url,options);
      return fetchDetached(url,options);
    };
    await assert.rejects(writePlan(plan,file(),signal(),()=>{},allow,read,{segments:[]}),
      err => err.status === 403 && err.pageUnavailable && !err.canSkip);
    assert.equal(hits.filter(p => p === '/lost.m4s').length,1);
    assert.ok(!hits.includes('/tail.m4s'));
  });
}

test('a temporarily unavailable first playlist recovers without another toolbar click', async t => {
  let requests = 0;
  const url = await fixture(t, (_uri, res) => {
    if (++requests === 1) res.writeHead(503).end();
    else res.end(playlist(0, [segment('complete.ts')], true));
  });
  const plan = await loadPlan(url, allow);
  assert.equal(requests, 2);
  assert.equal(plan.parts[0].url, new URL('complete.ts',url).href);
});

test('a live segment refused after a completed segment can be saved before returning to the source', async t => {
  const url = await fixture(t, (uri, res) => {
    if (uri.pathname.endsWith('.m3u8')) res.end(playlist(3, [segment('good.ts'), segment('expired.ts')]));
    else if (uri.pathname === '/good.ts') res.end(packet(7));
    else res.writeHead(403).end();
  });
  const writer = file();
  const result = await writeLivePlan(await loadPlan(url, allow), writer, signal(), signal(), allow, () => {});
  assert.equal(result.sourceReadError, true);
  assert.match(result.interruption, /動画区間.*403/);
  assert.match(result.interruption, /2 区間目（取得開始から 0:01 付近）/);
  assert.deepEqual(writer.data, packet(7));
});

test('a partially received manifest is discarded before reading it again from a reconnected player', async () => {
  const url = 'https://player.example/test.m3u8', encoder = new TextEncoder();
  let count = 0;
  const plan = await loadPlan(url, allow, undefined, null, async () => {
    const first = ++count === 1;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(first ? '#EXTM3U\n#EXTINF:9,\nstale.ts\n' : playlist(7, [segment('correct.ts')], true)));
        if (!first) controller.close();
      },
      pull(controller) { controller.error(Object.assign(new Error('test disconnect'), { readerDisconnected:true, pageUnavailable:true, retryable:true })); }
    });
    return { url, ok:true, body, headers:new Headers() };
  });
  assert.equal(count, 2);
  assert.deepEqual(plan.parts.map(p => p.url), ['https://player.example/correct.ts']);
});

test('a player disconnect after HTTP 403 does not turn a known refusal into a connection retry', async () => {
  const url = 'https://player.example/test.m3u8';
  let attempts = 0;
  await assert.rejects(loadPlan(url, allow, undefined, null, async () => {
    attempts++;
    return { url, ok:false, status:403, fromPlayer:true, body: { async cancel() {
      throw Object.assign(new Error('test disconnect'), { pageUnavailable:true, readerDisconnected:true, retryable:true });
    } } };
  }), error => error.status === 403);
  assert.equal(attempts, 1);
});
