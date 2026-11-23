import { pagePrefix, readEntry, statusPrefix } from './queue.mjs';

const directory = 'download-queue-v1';
const validRun = id => /^[a-f\d-]{36}$/.test(id);
const needsFiles = state => ['queued', 'fetching', 'recording', 'ready', 'saveQueued', 'saving'].includes(state?.phase);
export const runLock = run => 'embedded-video-work/' + run;

async function folder(run, create = false) {
  if (!validRun(run)) throw new Error('一時ファイルを特定できません。');
  const root = await navigator.storage.getDirectory();
  const queue = await root.getDirectoryHandle(directory, { create });
  return queue.getDirectoryHandle(run, { create });
}

export async function spool(run, name, create = false) {
  if (!['video', 'audio', 'result.json', 'export'].includes(name)) throw new Error('一時ファイル名が不正です。');
  return (await folder(run, create)).getFileHandle(name, { create });
}

export async function removeExport(run) {
  try { await (await folder(run)).removeEntry('export'); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
}

export async function putResult(run, result) {
  const handle = await spool(run, 'result.json', true);
  const writer = await handle.createWritable();
  try { await writer.write(JSON.stringify(result)); await writer.close(); }
  catch (error) { await writer.abort().catch(() => {}); throw error; }
}

export async function getResult(run) {
  try {
    const handle = await spool(run, 'result.json');
    return JSON.parse(await (await handle.getFile()).text());
  } catch (error) {
    if (error.name === 'NotFoundError' || error instanceof SyntaxError) throw missingSpool();
    throw error;
  }
}

export function missingSpool() {
  const error = new Error('取得済みの一時ファイルを読み出せません。「再取得」で動画を取り直してください。');
  error.missingSpool = true;
  return error;
}

export async function dropFiles(run) {
  if (!validRun(run)) return;
  const root = await navigator.storage.getDirectory();
  try {
    const queue = await root.getDirectoryHandle(directory);
    await queue.removeEntry(run, { recursive: true });
  } catch (error) { if (error.name !== 'NotFoundError') throw error; }
}

export async function cleanQueueFiles() {
  const root = await navigator.storage.getDirectory();
  let queue;
  try { queue = await root.getDirectoryHandle(directory); }
  catch (error) { if (error.name === 'NotFoundError') return; throw error; }
  const runs = [];
  for await (const name of queue.keys()) if (validRun(name)) runs.push(name);
  const data = await chrome.storage.session.get(null);
  const owners = new Map(Object.entries(data).filter(([key]) => key.startsWith(pagePrefix)).map(([, page]) => [page.run, page.id]));
  for (const run of runs) {
    const id = owners.get(run);
    if (id && needsFiles(data[statusPrefix + id])) continue;
    await navigator.locks.request(runLock(run), { ifAvailable: true }, async lock => {
      if (!lock) return;
      // A retry reuses its run and may have finished since the directory was listed.
      if (id) {
        const {page, state} = await readEntry(id);
        if (page?.run === run && needsFiles(state)) return;
      }
      await dropFiles(run);
    });
  }
}
