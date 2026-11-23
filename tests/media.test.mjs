import assert from 'node:assert/strict';
import test from 'node:test';
import { hostPattern, safeName, timeLabel, videosFrom, providerHints } from '../extension/media.mjs';
import { parsePlaylist } from '../extension/hls.mjs';

const base = 'https://cdn.example/a/master.m3u8?token=demo';
const parse = text => parsePlaylist('#EXTM3U\n' + text, base);

test('HTML video sources retain signed URLs and deduplicate across reports', () => {
  const url = 'https://cdn.example/clip?key=a%2Fb';
  const { videos, dash } = videosFrom([
    { url, source: 'video', label: 'テスト', width: 1280, height: 720 },
    { url, source: 'video', type: 'video/webm; codecs=vp8' },
    { url: 'https://cdn.example/clip.mpd', source: 'resource' },
    { url: 'https://cdn.example/manifest', source: 'video' },
    { url: 'https://cdn.example/manifest', source: 'resource', type: 'application/dash+xml' },
    { url: 'https://cdn.example/001.m4s', source: 'video' },
    { url: 'https://cdn.example/player', source: 'meta' }
  ]);
  assert.equal(videos.length, 1);
  assert.deepEqual([videos[0].url, videos[0].label, videos[0].extension, videos[0].width, dash], [url, 'テスト', 'webm', 1280, true]);
});

test('download filenames are valid on Windows and retain Japanese', () => {
  assert.equal(safeName('..CON.mp4', 'mp4'), '_CON.mp4');
  assert.equal(safeName('動画/第一話?.m3u8', 'ts'), '動画_第一話_.ts');
  assert.equal(timeLabel(3672.3), '1:01:12');
  assert.equal(hostPattern('http://localhost:8080/foo'), 'http://localhost/*');
  assert.throws(() => hostPattern('file:///secret'));
  assert.equal(providerHints(['https://notyoutube.com', 'https://player.vimeo.com/video/1']).length, 1);
});

test('safe filenames preserve Japanese titles, remove a padded extension and escape numbered Windows devices', () => {
  assert.equal(safeName('  星空の記録.MP4　','mp4'),'星空の記録.mp4');
  for (const digit of ['¹','²','³']) {
    assert.equal(safeName('COM'+digit+'.予告.mp4','mp4'),'_COM'+digit+'.予告.mp4');
    assert.equal(safeName('lpt'+digit,'mp4'),'_lpt'+digit+'.mp4');
  }
  assert.equal(safeName('COM²の記録','mp4'),'COM²の記録.mp4');
});

test('HLS master selects the highest video variant and the default audio from its group', () => {
  const master = parse('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="other",DEFAULT=YES,URI="wrong.m3u8"\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",AUTOSELECT=YES,URI="en.m3u8"\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="日本語",DEFAULT=YES,URI="ja.m3u8?sig=a%2Fb"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=9000,RESOLUTION=1920x1080,AUDIO="audio"\nvideo.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=10,CODECS="mp4a.40.2"\naudio-only.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=50,RESOLUTION=640x360\nlow.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=90,RESOLUTION=1280x720\nhigh.m3u8?sig=a%2Fb');
  assert.equal(master.variant.url, 'https://cdn.example/a/video.m3u8');
  assert.equal(master.variant.resolution, '1920x1080');
  assert.equal(master.variant.audio.url, 'https://cdn.example/a/ja.m3u8?sig=a%2Fb');
  assert.equal(master.variant.audio.name, '日本語');
  assert.ok(master.members.has('https://cdn.example/a/en.m3u8'));
  const mixed = parse('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",URI="alt.m3u8"\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",DEFAULT=YES,NAME="Main"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=10,AUDIO="g"\nmuxed.m3u8');
  assert.equal(mixed.variant.audio, undefined);
});

test('fragmented MP4 keeps the init section and consecutive byte ranges', () => {
  const plan = parse('#EXT-X-MAP:URI="movie.mp4",BYTERANGE="100@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:20@100\nmovie.mp4\n#EXTINF:2,\n#EXT-X-BYTERANGE:21\nmovie.mp4\n#EXT-X-ENDLIST');
  assert.deepEqual([plan.init.start, plan.init.end, plan.parts[1].start, plan.parts[1].end, plan.duration, plan.extension], [0, 99, 120, 140, 3, 'mp4']);
});

test('incomplete, encrypted, unresolved and discontinuous playlists stop explicitly', () => {
  const vod = '#EXTINF:1,\nv.ts\n#EXT-X-ENDLIST';
  for (const text of [
    '#EXTINF:1,\nv.ts', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n' + vod,
    '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="key"\n' + vod,
    '#EXTINF:1,\na.ts\n#EXT-X-DISCONTINUITY\n' + vod, '#EXT-X-GAP\n' + vod,
    '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="missing"\nv.m3u8',
    '#EXTINF:1,\n#EXT-X-BYTERANGE:10\nv.mp4\n#EXT-X-ENDLIST', '#EXTINF:1,\n#EXT-X-ENDLIST',
    '#EXTINF:1,\nfile:///outside.ts\n#EXT-X-ENDLIST'
  ]) assert.throws(() => parse(text), text);
  assert.equal(parse('#EXT-X-KEY:METHOD=NONE\n' + vod).extension, 'ts');
});
