import assert from 'node:assert/strict';

// Each listed segment is one independently decodable frame in the existing 12,800 Hz fixture.
export function serveArchive637(res, leaf, init, keyframe) {
  if (leaf === 'video.m3u8') {
    const parts = Array.from({length:637}, (_, i) => '#EXTINF:' + (i ? 4 : 6) + ',\np' + (i+1) + '.m4s');
    res.writeHead(200, {'Content-Type':'application/vnd.apple.mpegurl'}).end(
      ['#EXTM3U','#EXT-X-VERSION:7','#EXT-X-TARGETDURATION:6','#EXT-X-MAP:URI="init.mp4"',...parts,'#EXT-X-ENDLIST'].join('\n'));
    return;
  }
  if (leaf === 'init.mp4') { res.writeHead(200, {'Content-Type':'video/mp4'}).end(init); return; }
  const part = Number(/^p(\d+)\.m4s$/.exec(leaf)?.[1]);
  if (!(part >= 1 && part <= 637)) { res.writeHead(404).end(); return; }
  const bytes = Buffer.from(keyframe);
  const start = part === 1 ? 0 : 6 + (part-2)*4;
  bytes.writeUInt32BE(part, bytes.indexOf('mfhd')+8);
  bytes.writeUInt32BE((part === 1 ? 6 : 4)*12800, bytes.indexOf('tfhd')+12);
  bytes.writeBigUInt64BE(BigInt(start*12800), bytes.indexOf('tfdt')+8);
  bytes.writeUInt32BE(0, bytes.indexOf('trun')+20);
  res.writeHead(200, {'Content-Type':'video/mp4'}).end(bytes);
}

export async function testAutoGap637({context, worker, top, cdn, base, startFromToolbar, requests, managerCount}) {
  const source = await context.newPage();
  try {
    const before = managerCount();
    await source.goto(top+'/watch?case=gapauto637');
    await source.evaluate(async url => { document.title='欠損テスト637'; await (await fetch(url)).text(); },
      cdn+'/gapauto637/1080p/video.m3u8');
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, source.url());
    const start = requests.length;
    await startFromToolbar(source,tabId);
    await source.waitForFunction(() => /^(保存済み|エラー)/.test(document.title),null,{timeout:60000});
    assert.match(await source.title(),/^保存済み（欠損あり）/, 'a single failed segment must not leave the download waiting for a click');
    assert.equal(managerCount(),before,'no per-download queue opened');
    const segments = requests.slice(start).filter(r => r.scenario==='gapauto637' && /^p\d+\.m4s$/.test(r.leaf));
    assert.equal(segments.length,637);
    for (const [i,r] of segments.entries()) {
      assert.equal(r.leaf,'p'+(i+1)+'.m4s');
      assert.equal(r.status,i===7 ? 403 : 200);
      assert.ok(r.pageClient,'the archive is available through the original player');
    }
    const list = await context.newPage();
    try {
      await list.goto(base+'/manager.html');
      const row = list.locator('#list li').filter({hasText:'欠損テスト637'});
      await row.locator('.phase[data-state="saved"]').waitFor();
      assert.match(await row.textContent(),/8\/637 区間目（0:30〜0:34）/);
      const movie = await list.evaluate(async () => {
        const root=await navigator.storage.getDirectory(), folder=await root.getDirectoryHandle('自動スキップ');
        const file=await (await folder.getFileHandle('欠損テスト637（欠損あり）.mp4')).getFile();
        const {Input,MP4,BlobSource,EncodedPacketSink}=await import('./vendor/mediabunny-1.66.2.mjs');
        const input=new Input({formats:[MP4], source:new BlobSource(file)});
        try {
          const times=[];
          for await (const packet of new EncodedPacketSink(await input.getPrimaryVideoTrack()).packets()) times.push(packet.timestamp);
          return {frames:times.length, first:times[0], join:times[7], last:times.at(-1), duration:await input.computeDuration()};
        } finally { input.dispose(); }
      });
      assert.deepEqual(movie,{frames:636,first:0,join:30,last:2542,duration:2546});
    } finally { await list.close(); }
  } finally { await source.close(); }
  console.log('637 VOD segments requested once; the 8th returned 403; automatically saved 636 frames with the 0:30-0:34 omission');
}
