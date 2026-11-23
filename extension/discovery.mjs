import { fullPlaylistUrl, httpUrl } from './media.mjs';

export const allSites = ['http://*/*', 'https://*/*'];
export const detectionSetting = 'streamDetection';
export const tabKey = tabId => 'detected-streams-' + tabId;

export function playlistResponse(details) {
  if (details.tabId < 0 || details.method !== 'GET' ||
      (details.statusCode !== 304 && (details.statusCode < 200 || details.statusCode >= 300)) ||
      details.initiator?.startsWith('chrome-extension://')) return null;
  const url = httpUrl(details.url);
  if (!url) return null;
  const type = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value?.split(';')[0].trim();
  if (!/\.m3u8$/i.test(url.pathname) && !/^(?:application|audio)\/(?:vnd\.apple\.|x-)?mpegurl$/i.test(type || '')) return null;
  url.hash = '';
  const item = { url: fullPlaylistUrl(url.href), frameId: details.frameId, documentId: details.documentId };
  if (Number.isFinite(details.timeStamp)) item.seenAt = details.timeStamp;
  const origin = httpUrl(details.initiator)?.origin;
  const grants = details.responseHeaders?.filter(h => h.name.toLowerCase() === 'access-control-allow-origin') || [];
  const grant = grants.length === 1 ? grants[0].value?.trim() : null;
  if (item.documentId && origin && (origin === url.origin || grant === origin || grant === '*')) {
    item.pageOrigin = origin;
  }
  return item;
}

export function rememberStream(streams, item) {
  const existing = streams.findIndex(s => s.url === item.url && s.frameId === item.frameId && s.documentId === item.documentId);
  if (existing !== -1) {
    if (streams[existing].pageOrigin === item.pageOrigin && !(item.seenAt > (streams[existing].seenAt || 0))) return streams;
    return streams.map((s, i) => i === existing ? item : s);
  }
  // Keep a likely master (usually the first request) and the most recent renditions.
  return streams.length < 32 ? [...streams, item] : [streams[0], ...streams.slice(-30), item];
}
