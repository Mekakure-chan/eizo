import { inlineEngine, registerEngine } from './engine-host.mjs';
import { allSites, detectionSetting, playlistResponse, rememberStream, tabKey } from './discovery.mjs';
import { cleanClosedStages } from './staging.mjs';
import { handleQueueRequest, managerClosed } from './queue.mjs';
import { cleanQueueFiles } from './queue-files.mjs';

registerEngine();
const manifest = chrome.runtime.getManifest();
const queues = new Map();
let enabled = chrome.storage.local.get(detectionSetting).then(value => !!value[detectionSetting]);
function changeTab(tabId, update) {
  const previous = queues.get(tabId) || Promise.resolve();
  const task = previous.then(async () => {
    const key = tabKey(tabId);
    const items = (await chrome.storage.session.get(key))[key] || [];
    const next = await update(items);
    if (next === items) return;
    if (next.length) await chrome.storage.session.set({ [key]: next });
    else await chrome.storage.session.remove(key);
    const count = new Set(next.map(s => s.url)).size;
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: count ? 'HLS' : '' }),
      chrome.action.setTitle({ tabId, title: count
        ? manifest.name + '\nHLS配信を' + count + '件検出 · クリックして取得'
        : manifest.action.default_title })
    ]);
  }).catch(error => {
    if (!/tab|frame|closed/i.test(error.message || '')) console.warn('HLS検出状態を更新できませんでした。', error.name);
  });
  queues.set(tabId, task);
  task.finally(() => { if (queues.get(tabId) === task) queues.delete(tabId); });
  return task;
}

chrome.action.setBadgeBackgroundColor({ color: '#ad302b' });
function observeResponse(details) {
  const item = playlistResponse(details);
  if (!item) return;
  changeTab(details.tabId, async items => {
    if (!await enabled) return items;
    const doc = await chrome.webNavigation.getFrame({ tabId: details.tabId, frameId: item.frameId });
    if (!doc || (item.documentId && doc.documentId !== item.documentId)) return items;
    if (item.pageOrigin && new URL(doc.url).origin !== item.pageOrigin) delete item.pageOrigin;
    return rememberStream(items, { ...item, documentId: doc.documentId });
  });
}
function listen(value) {
  const event = chrome.webRequest.onResponseStarted;
  if (event.hasListener(observeResponse)) event.removeListener(observeResponse);
  if (value) event.addListener(observeResponse, { urls: allSites, types: ['xmlhttprequest', 'media', 'other', 'object', 'main_frame', 'sub_frame'] }, ['responseHeaders']);
}
// Reinstall the filter after an optional host grant; a filter registered with no
// effective host access at install time does not start receiving requests by itself.
listen(true);
const initialSetting = enabled;
initialSetting.then(value => { if (enabled === initialSetting && !value) listen(false); });

chrome.webNavigation.onCommitted.addListener(event => {
  if (event.frameId === 0) {
    if (!event.url.startsWith(chrome.runtime.getURL('manager.html'))) void managerClosed(event.tabId).catch(() => {});
  }
  changeTab(event.tabId, items => {
    const next = items.filter(s => (event.frameId !== 0 && s.frameId !== event.frameId) || s.documentId === event.documentId);
    return next.length === items.length ? items : next;
  });
});
chrome.webNavigation.onHistoryStateUpdated.addListener(event => {
  changeTab(event.tabId, items => !items.length ? items : event.frameId === 0 ? [] : items.filter(s => s.frameId !== event.frameId));
});
chrome.tabs.onRemoved.addListener(tabId => {
  changeTab(tabId, () => []);
  void managerClosed(tabId).catch(() => {});
});
chrome.tabs.onReplaced.addListener((_, removed) => {
  changeTab(removed, () => []);
});
chrome.runtime.onStartup.addListener(() => { void cleanClosedStages().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void cleanQueueFiles().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void cleanQueueFiles().catch(() => {}); });

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) ||
      !['queue-add', 'queue-find', 'queue-open', 'queue-index', 'queue-claim', 'queue-close-saved', 'queue-close-source', 'queue-recover'].includes(msg?.op)) return;
  handleQueueRequest(msg, sender, inlineEngine).then(ok => respond({ ok }), error => respond({ error: error.message }));
  return true;
});

async function clearDetections() {
  const data = await chrome.storage.session.get(null);
  const ids = Object.keys(data).filter(key => /^detected-streams-\d+$/.test(key));
  await Promise.all(ids.map(key => changeTab(Number(key.slice('detected-streams-'.length)), () => [])));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[detectionSetting]) return;
  const value = !!changes[detectionSetting].newValue;
  enabled = Promise.resolve(value);
  listen(value);
  if (!value) void clearDetections();
});
chrome.permissions.onRemoved.addListener(async removed => {
  if (removed.origins?.length && !await chrome.permissions.contains({ origins: allSites })) {
    await chrome.storage.local.remove(detectionSetting);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) ||
      msg?.op !== 'detected' || !Number.isInteger(msg.tabId)) return;
  (async () => {
    if (!await enabled) return [];
    await queues.get(msg.tabId);
    const key = tabKey(msg.tabId);
    return (await chrome.storage.session.get(key))[key] || [];
  })().then(respond, () => respond([]));
  return true;
});
