// Locks are released by Chrome when a transfer tab or the browser closes.
const lockName = name => 'embedded-video-saver/hls/' + name;

async function sweep(dir) {
  for await (const name of dir.keys()) {
    if (!/^[a-f\d-]{36}\.media$/.test(name)) continue;
    await navigator.locks.request(lockName(name), { ifAvailable: true }, async lock => {
      if (lock) await dir.removeEntry(name).catch(() => {});
    });
  }
}

export async function cleanClosedStages() {
  const root = await navigator.storage.getDirectory();
  let dir;
  try { dir = await root.getDirectoryHandle('stream-recorder-v1'); }
  catch (error) { if (error.name === 'NotFoundError') return; throw error; }
  await sweep(dir);
}

export async function stageFile() {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('stream-recorder-v1', { create: true });
  await sweep(dir);
  const name = crypto.randomUUID() + '.media';
  let release, ready, fail;
  const hold = new Promise(resolve => { release = resolve; });
  const opened = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
  const lifetime = navigator.locks.request(lockName(name), async () => {
    const handle = await dir.getFileHandle(name, { create: true });
    ready(handle);
    try { await hold; } finally { await dir.removeEntry(name); }
  });
  lifetime.catch(fail);
  return { handle: await opened, dispose: () => { release(); return lifetime; } };
}
