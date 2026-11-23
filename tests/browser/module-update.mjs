import assert from 'node:assert/strict';
import { copyFile, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function testModuleUpdate({context,base,cdn,project,extension}) {
  const shipped = path.join(project,'extension');
  for (const version of ['1.6.10','1.6.12']) {
    // Only the disposable browser's copy changes. Keep the same document and module URLs throughout the upgrade.
    const name = 'fixture-warm-' + version, dir = path.join(extension,name);
    await cp(shipped,dir,{recursive:true});
    const installed = path.join(dir,'mp4.mjs');
    const history = process.env.HLS_TEST_OLD_MODULES;
    if (history) {
      for (const file of ['mp4','queue-transfer']) await copyFile(path.join(history,file+'-'+version+'.mjs'),path.join(dir,file+'.mjs'));
    } else {
      // Minimal public surface of the two previous versions. The real TS converter is still available.
      let api = "export { exportTsAsMp4 } from '../mp4.mjs';";
      if (version === '1.6.12') api += "export class Mp4MergeError extends Error {name='Mp4MergeError'}; export function classifyMergeError(e){return e}";
      await writeFile(installed,api);
    }
    await writeFile(path.join(dir,'probe.html'),'<!doctype html><title>Extension update test</title>');
    const probe = await context.newPage();
    try {
      await probe.goto(base+'/'+name+'/probe.html');
      const hasMergeClass = await probe.evaluate(async withHistory => {
        window.loadedMp4 = await import('./mp4.mjs');
        if (withHistory) window.loadedTransfer = await import('./queue-transfer.mjs');
        return typeof loadedMp4.Mp4MergeError === 'function';
      },!!history);
      assert.equal(hasMergeClass,version==='1.6.12');
      for (const file of ['mp4','queue-transfer']) await copyFile(path.join(shipped,file+'.mjs'),path.join(dir,file+'.mjs'));
      const result = await probe.evaluate(async cdn => {
        if (await import('./mp4.mjs') !== window.loadedMp4) throw Error('Previous module context was lost');
        const {dropFiles,spool} = await import('./queue-files.mjs');
        const {Input,BlobSource,EncodedPacketSink,MP4} = await import('./vendor/mediabunny-1.66.2.mjs');
        // A fresh caller and a transfer already in progress must both work with the cached converter.
        const fresh = await import('./queue-transfer.mjs?updated');
        const transfer = window.loadedTransfer || fresh;
        const signal = new AbortController().signal, files = [];
        for (const [route,skipGaps] of [['updatepair/playlist.m3u8',false],['updategap/1080p/video.m3u8',true]]) {
          const run = crypto.randomUUID();
          try {
            const output = await transfer.acquireMedia({run,job:{kind:'hls',url:cdn+'/'+route}},
              {signal,stop:signal,skipGaps,report:()=>{}});
            const dest = await spool(run,'export',true), writer = await dest.createWritable();
            try {await transfer.exportMedia(run,'mp4',writer,signal,()=>{}); await writer.close();}
            catch (error) {await writer.abort().catch(()=>{}); throw error;}
            const input = new Input({formats:[MP4],source:new BlobSource(await dest.getFile())});
            try {
              const hasData = async track => track && (await new EncodedPacketSink(track).getFirstPacket())?.data.byteLength > 0;
              files.push({video:await hasData(await input.getPrimaryVideoTrack()),audio:await hasData(await input.getPrimaryAudioTrack()),
                duration:await input.computeDuration(),omitted:output.omittedRanges?.length || 0});
            } finally {input.dispose();}
          } finally {await dropFiles(run);}
        }
        const {prepareGappedMp4} = await import('./gapped-mp4.mjs');
        const error = await prepareGappedMp4(new Blob(),null,null,signal).catch(e=>e);
        const phases = [];
        for (const caller of new Set([fresh,transfer])) {
          if (caller.finishMergeFailure) await caller.finishMergeFailure(crypto.randomUUID(),error,[],async state=>{phases.push(state.phase); return false;});
        }
        return {files,phases,sameClass:!loadedMp4.Mp4MergeError || error instanceof loadedMp4.Mp4MergeError};
      },cdn);
      assert.deepEqual(result.files.map(f=>[f.video,f.audio,f.duration>0,f.omitted>0]),[[true,true,true,false],[true,true,true,true]]);
      assert.ok(result.sameClass,'an already running queue must recognize an unrecoverable merge failure');
      const classifiers = history && version==='1.6.12' ? 2 : 1;
      assert.deepEqual(result.phases,Array(classifiers).fill('mergeFailed'));
    } finally {await probe.close();}
    console.log('warm update from',version,'saved separate audio/video and a gapped archive as playable MP4 tracks');
  }
}
