import { hostPattern, httpUrl } from './media.mjs';
import { sendQueue } from './queue.mjs';

async function launch(job, url) {
  const key = 'job-' + crypto.randomUUID();
  await chrome.storage.session.set({ [key]: job });
  try {
    await chrome.tabs.create({ url: url + '#' + key });
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
}

export async function openTransfer(job, page) {
  if (page === 'transfer.html') return launch(job, chrome.runtime.getURL(page));
  const source = httpUrl(job.sourceUrl);
  return sendQueue('queue-add', { job, sourceUrl: source?.href || job.url, sourceTitle: job.sourceTitle || job.label,
    sourceTabId: job.tabId, manual: !source, incognito: chrome.extension.inIncognitoContext });
}

export async function openSourceChoices(job, view) {
  const top = await chrome.webNavigation.getFrame({ tabId: job.tabId, frameId: 0 }).catch(() => null);
  if (!top) throw new Error('元の動画タブが閉じられています。動画ページで拡張を開いてください。');
  const tab = await chrome.tabs.get(job.tabId).catch(() => null);
  if (job.sourceUrl ? (tab?.url || top.url) !== job.sourceUrl : job.sourceDoc && top.documentId !== job.sourceDoc) {
    throw new Error('元のタブのページが変わりました。保存したい動画ページで拡張を開いてください。');
  }
  const url = new URL(chrome.runtime.getURL('popup.html'));
  url.searchParams.set('tab', job.tabId);
  url.searchParams.set('doc', top.documentId);
  if (view) url.searchParams.set('view', view);
  if (view === 'recover') return launch({ previous: job.url, observedAt: job.observedAt, sourceUrl: top.url }, url.href);
  await chrome.tabs.create({ url: url.href });
}

export async function readJob() {
  const key = location.hash.slice(1);
  if (/^job-[\da-f-]{36}$/.test(key)) {
    const values = await chrome.storage.session.get(key);
    if (values[key]) {
      sessionStorage.setItem('job', JSON.stringify(values[key]));
      await chrome.storage.session.remove(key);
      history.replaceState(null, '', location.pathname + location.search);
    }
  }
  return JSON.parse(sessionStorage.getItem('job') || 'null');
}

export async function requireOrigins(urls) {
  const origins = [...new Set(urls.map(hostPattern))];
  const missing = (await Promise.all(origins.map(async origin =>
    await chrome.permissions.contains({ origins: [origin] }) ? null : origin))).filter(Boolean);
  if (missing.length) {
    const error = new Error('次の配信元の読み取りを許可してください。 ' + missing.map(origin => origin.slice(0, -2)).join('、'));
    error.origins = missing;
    throw error;
  }
}

