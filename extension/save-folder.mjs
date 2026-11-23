export const maxSaveFolders = 3;

// Keep each scope's selection and its directory handles in one IndexedDB record.
async function folderRecord(scope, settings) {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open('embedded-video-saver-preferences', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('folders');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const reading = settings === undefined;
      const tx = db.transaction('folders', reading ? 'readonly' : 'readwrite');
      const store = tx.objectStore('folders');
      const request = reading ? store.get(scope) : store.put(settings, scope);
      tx.oncomplete = () => resolve(reading ? request.result : undefined);
      tx.onabort = () => reject(tx.error || request.error);
    });
  } finally { db.close(); }
}

export async function getFolderSettings(scope) {
  const record = await folderRecord(scope);
  if (record?.slots) return record;
  const slots = Array(maxSaveFolders).fill(null);
  // Versions through 1.5.15 stored the selected handle directly. Its ID must agree across tabs.
  if (record?.kind === 'directory') slots[0] = {id:'legacy', handle:record};
  return {slots, activeId:slots[0]?.id ?? null};
}

export function selectedFolder(settings) {
  return settings.slots.find(entry => entry && entry.id === settings.activeId);
}

export function folderLabel(settings, entry) {
  const name = entry.handle.name || 'ルートフォルダー';
  const duplicate = settings.slots.some(other => other && other.id !== entry.id && other.handle.name === entry.handle.name);
  return duplicate ? name + '（登録 ' + (settings.slots.indexOf(entry) + 1) + '）' : name;
}

export async function getSaveFolder(scope) {
  return selectedFolder(await getFolderSettings(scope))?.handle;
}

function updateFolders(scope, change) {
  // isSameEntry is asynchronous. Serialize the complete read, comparison and write across manager tabs.
  return navigator.locks.request('embedded-video-saver/folder-settings/' + scope, async () => {
    const settings = await getFolderSettings(scope);
    const before = settings.activeId;
    const changed = await change(settings);
    if (changed) await folderRecord(scope, settings);
    return {changed, selectionChanged:before !== settings.activeId};
  });
}

export function registerSaveFolder(scope, handle) {
  if (!(handle instanceof FileSystemDirectoryHandle)) throw new Error('保存するフォルダーを選んでください。');
  return updateFolders(scope, async settings => {
    for (const entry of settings.slots) {
      if (entry && await handle.isSameEntry(entry.handle)) return false;
    }
    const index = settings.slots.indexOf(null);
    if (index < 0) throw new Error('保存先は3か所までです。「登録先を管理」から空きを作れます。');
    const id = crypto.randomUUID();
    if (!settings.slots.some(Boolean)) settings.activeId = id;
    settings.slots[index] = {id, handle};
    return true;
  });
}

export function selectSaveFolder(scope, id) {
  return updateFolders(scope, settings => {
    if (id === settings.activeId) return false;
    if (id !== null && !settings.slots.some(entry => entry && entry.id === id)) throw new Error('この保存先はすでに登録解除されています。');
    settings.activeId = id;
    return true;
  });
}

export function removeSaveFolder(scope, id) {
  return updateFolders(scope, settings => {
    const index = settings.slots.findIndex(entry => entry && entry.id === id);
    if (index < 0) return false;
    settings.slots[index] = null;
    if (settings.activeId === id) settings.activeId = null;
    return true;
  });
}

export const saveWaitText = 'ストレージへの保存は1本ずつ行います。書き出しの順番を待っています。';
export const storageSaveText = '動画ファイルをストレージに保存しています。';
export const commitStatus = {saveStage:'committing',text:'動画ファイルの保存を確定しています。',progress:null,progressDetail:null};

export function saveProgress(publish, clock = Date.now) {
  let lastPercent = 0, lastTime = -Infinity;
  return fraction => {
    if (!Number.isFinite(fraction) || fraction >= 1) return;
    const percent = Math.min(99, Math.round(fraction * 100)), now = clock();
    if (percent <= lastPercent || now - lastTime < 200) return;
    lastPercent = percent; lastTime = now;
    publish(percent / 100);
  };
}

// All queue tabs and the offscreen document share this FIFO lock. The caller releases
// it after the destination has finished committing or aborting the previous file.
export function acquireSaveSlot(signal) {
  signal.throwIfAborted();
  return new Promise((granted, reject) => {
    navigator.locks.request('embedded-video-saver/export/0', {signal}, () => new Promise(release => {
      granted(release);
    })).catch(reject);
  });
}

const nameLock = 'embedded-video-saver/destination-name';

export function reserveDestination(directory, filename, signal) {
  return navigator.locks.request(nameLock, { signal }, async () => {
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    for (let n = 1; ; n++) {
      signal.throwIfAborted();
      const name = n === 1 ? filename : stem + ' (' + n + ')' + ext;
      try { await directory.getFileHandle(name); }
      catch (error) {
        if (error.name === 'TypeMismatchError') continue; // This name is already a directory.
        if (error.name !== 'NotFoundError') throw error;
        return directory.getFileHandle(name, { create: true });
      }
    }
  });
}

export function removeEmptyReservation(directory, handle) {
  return navigator.locks.request(nameLock, async () => {
    const current = await directory.getFileHandle(handle.name);
    if (await current.isSameEntry(handle) && (await current.getFile()).size === 0) {
      await directory.removeEntry(handle.name);
    }
  });
}
