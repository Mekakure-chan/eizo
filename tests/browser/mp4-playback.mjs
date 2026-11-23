import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

export async function testSavedPlayback(context, base) {
  const fixtures = await Promise.all(['three-segments.ts','video-fragments.mp4','audio-fragments.mp4']
    .map(async name => [...await readFile(new URL('../fixtures/' + name, import.meta.url))]));
  const page = await context.newPage();
  try {
    await page.goto(base + '/manager.html');
    const results = await page.evaluate(async ([tsBytes, v, a]) => {
      const {exportTsAsMp4} = await import('./mp4.mjs');
      const {preparePair} = await import('./paired-mp4.mjs');
      const root = await navigator.storage.getDirectory(), signal = new AbortController().signal;
      const ts = new Uint8Array(tsBytes), asBlob = bytes => new Blob([new Uint8Array(bytes)]);
      const results = [];
      for (const type of ['ts','pair']) {
        const handle = await root.getFileHandle(type + '-playback.mp4',{create:true});
        const writer = await handle.createWritable();
        if (type === 'ts') {
          const bounds = Array.from({length:24},(_,i)=>[2632,4700,ts.length].map(end=>i*ts.length+end)).flat();
          await exportTsAsMp4(new Blob(Array(24).fill(ts)),bounds,36,writer,signal,()=>{});
        } else {
          const pair = await preparePair(asBlob(v),asBlob(a),{video:{},audio:{}},false,signal);
          try { await pair.writeTo(writer,signal,()=>{}); } finally { pair.dispose(); }
        }
        await writer.close();
        const file = await handle.getFile(), video = document.createElement('video');
        video.muted = true;
        document.body.append(video);
        const url = URL.createObjectURL(file);
        try {
          const timeout = AbortSignal.timeout(10000);
          const failed = new Promise((_,reject) => {
            timeout.addEventListener('abort',()=>reject(new Error(type + ' playback timed out')),{once:true});
            video.onerror = () => reject(new Error(type + ': ' + video.error.message));
          });
          const frame = () => Promise.race([failed,new Promise(resolve=>
            video.requestVideoFrameCallback((_,meta)=>resolve(meta.mediaTime)))]);
          const started = performance.now(), first = frame();
          video.src = url;
          await Promise.race([failed,video.play()]);
          const firstTime = await first, startupMs = Math.round(performance.now()-started);
          video.pause();
          const sought = new Promise(resolve => video.addEventListener('seeked', resolve, {once:true}));
          video.currentTime = type === 'ts' ? 35.6 : .44;
          await Promise.race([failed,sought]);
          const tail = (async () => {
            let time;
            do { time = await frame(); } while (time < (type === 'ts' ? 35.8 : .50));
            return time;
          })();
          await Promise.race([failed,video.play()]);
          const lastTime = await tail;
          results.push({type,firstTime,lastTime,duration:video.duration,startupMs});
        } finally {
          video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);
        }
      }
      return results;
    }, fixtures);
    for (const result of results) {
      assert.ok(result.firstTime < .2);
      assert.ok(result.lastTime >= (result.type === 'ts' ? 35.7 : .48), JSON.stringify(result));
      console.log('Saved MP4 playback',JSON.stringify(result));
    }
  } finally { await page.close(); }
}
