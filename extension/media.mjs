const mimeFormats = new Map([
  ['video/mp4', 'mp4'], ['video/webm', 'webm'], ['video/ogg', 'ogv'],
  ['video/quicktime', 'mov'], ['video/x-m4v', 'm4v'], ['video/x-matroska', 'mkv'],
  ['video/mpeg', 'mpeg'], ['video/x-msvideo', 'avi'], ['video/3gpp', '3gp']
]);
const directExtension = /\.(mp4|webm|ogv|mov|m4v|mkv|mpg|mpeg|avi|3gp)$/i;

export function httpUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url;
  } catch {}
  return null;
}

export function hostPattern(value) {
  const url = httpUrl(value);
  if (!url) throw new Error('HTTP または HTTPS の配信元を指定してください。');
  return url.protocol + '//' + url.hostname + '/*';
}

export function fullPlaylistUrl(href) {
  const mark = href.indexOf('?');
  if (mark < 0) return href;
  const fields = href.slice(mark + 1).split('&');
  // Reload directives request a particular live window. Keep the remaining query
  // bytes (including signed values, escaping, and order) exactly as published.
  const keep = fields.filter(field => !/^_HLS_(?:msn|part|skip)(?:=|$)/.test(field));
  if (keep.length === fields.length) return href;
  return href.slice(0, mark) + (keep.length ? '?' + keep.join('&') : '');
}

function pathName(url) {
  const leaf = url.pathname.split('/').pop() || '';
  try { return decodeURIComponent(leaf); } catch { return leaf; }
}

export function safeName(label, extension) {
  let stem = (label || '動画').normalize('NFC').replace(/\.(?:m3u8|mpd|mp4|webm|ogv|mov|m4v|mkv|mpg|mpeg|avi|3gp|ts)$/i, '');
  stem = stem.replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').trim();
  stem = [...stem].slice(0, 64).join('').replace(/^\.+|[ .]+$/g, '') || '動画';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = '_' + stem;
  return stem + '.' + extension;
}

export function timeLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const n = Math.floor(seconds);
  const mm = Math.floor(n / 60) % 60;
  const ss = String(n % 60).padStart(2, '0');
  return n >= 3600 ? Math.floor(n / 3600) + ':' + String(mm).padStart(2, '0') + ':' + ss : mm + ':' + ss;
}

export function videosFrom(items, pageTitle) {
  const videos = new Map();
  const excluded = new Set();
  let dash = false;
  for (const item of items) {
    const url = httpUrl(item.url);
    if (!url) continue;
    const type = (item.type || '').split(';')[0].trim().toLowerCase();
    const leaf = pathName(url);
    if (type === 'application/dash+xml' || /\.mpd$/i.test(leaf)) {
      dash = true;
      excluded.add(url.href);
      continue;
    }
    const hls = /mpegurl$/.test(type) || /\.m3u8$/i.test(leaf);
    const extension = mimeFormats.get(type) || leaf.match(directExtension)?.[1].toLowerCase() || '';
    if (!hls && (/\.(?:ts|m4s|cmfv|cmfa|aac|m4a|mp3|html?)$/i.test(leaf) || /^(?:audio|text)\//.test(type))) {
      excluded.add(url.href);
      continue;
    }
    if (!hls && !extension && item.source !== 'video') continue;
    const label = item.label || (!hls && leaf.match(directExtension) && leaf) || item.page || pageTitle || leaf || '動画';
    const href = hls ? fullPlaylistUrl(url.href) : url.href;
    const previous = videos.get(href);
    if (previous) {
      previous.extension ||= extension;
      if (hls) previous.kind = 'hls';
      continue;
    }
    videos.set(href, { kind: hls ? 'hls' : 'file', extension, url: href, label, leaf, host: url.host,
      width: item.width, height: item.height, duration: item.duration });
  }
  return { videos: [...videos.values()].filter(video => !excluded.has(video.url)), dash };
}

export function providerHints(urls) {
  const hosts = urls.map(value => httpUrl(value)?.hostname || '');
  const includes = domain => hosts.some(host => host === domain || host.endsWith('.' + domain));
  const hints = [];
  if (includes('youtube.com') || includes('youtube-nocookie.com') || includes('youtu.be')) {
    hints.push({ label: '自分が投稿した動画は YouTube Studio からMP4を保存できます。',
      text: 'YouTube Studio を開く', url: 'https://studio.youtube.com/' });
  }
  if (includes('vimeo.com')) {
    hints.push({ label: 'Vimeoでは投稿者が許可した動画に、動画ページのダウンロードボタンが表示されます。',
      text: 'Vimeo 公式の保存手順', url: 'https://help.vimeo.com/hc/en-us/articles/12426502581265' });
  }
  return hints;
}

// Submit one block at a time. File slices stay disk-backed and muxed bytes share their original buffer.
export async function writeMediaBlocks(source, writer, signal, progress) {
  const block = 4 * 1024 * 1024;
  const bytes = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : null;
  const size = bytes ? bytes.byteLength : source.size;
  for (let start = 0; start < size; start += block) {
    signal.throwIfAborted();
    const end = Math.min(start + block, size);
    await writer.write(bytes ? bytes.subarray(start,end) : source.slice(start,end));
    signal.throwIfAborted();
    progress?.(end / size);
  }
}

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
