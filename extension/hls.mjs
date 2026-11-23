import { incompletePart, mp4BoxReader } from './mp4-boxes.mjs';
import { httpUrl, timeLabel } from './media.mjs';

function attrs(line) {
  const result = {};
  const text = line.slice(line.indexOf(':') + 1);
  for (const match of text.matchAll(/(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    result[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return result;
}

function resolveUri(uri, base) {
  const url = uri && httpUrl(uri, base);
  if (!url || uri.includes('{$')) throw new Error('このHLSの配信URL形式には対応していません。');
  return url.href;
}

function makePart(uri, spec, base, previous) {
  const url = resolveUri(uri, base);
  if (spec == null) return { url };
  const match = /^(\d+)(?:@(\d+))?$/.exec(spec);
  if (!match) throw new Error('HLSのバイト範囲を読み取れません。');
  const size = Number(match[1]);
  const start = match[2] !== undefined ? Number(match[2]) : previous?.url === url ? previous.end + 1 : NaN;
  const end = start + size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || size < 1) throw new Error('HLSのバイト範囲が不正です。');
  return { url, start, end };
}

function samePart(a, b) {
  return a?.url === b?.url && a?.start === b?.start && a?.end === b?.end;
}

function rendition(group, type, media) {
  if (!group) return undefined;
  const choices = media.filter(item => item.TYPE === type && item['GROUP-ID'] === group);
  return choices.find(item => item.DEFAULT === 'YES') || choices.find(item => item.AUTOSELECT === 'YES') || choices[0];
}

function playlistInteger(lines, tag, fallback) {
  const prefix = '#EXT-X-' + tag + ':';
  const line = lines.find(item => item.startsWith(prefix));
  if (!line) return fallback;
  const value = line.slice(prefix.length);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('HLSの ' + tag + ' が不正です。');
  return Number(value);
}

export function parsePlaylist(text, base, followingLive = false, allowGaps = false) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('配信元からHLSプレイリストを取得できませんでした。');
  if (lines.some(line => /^#EXT-X-(?:SESSION-)?KEY:/.test(line) && attrs(line).METHOD !== 'NONE')) {
    throw new Error('暗号化されたHLSはファイル保存の対象外です。');
  }
  if (lines.some(line => line.startsWith('#EXT-X-STREAM-INF:'))) {
    const renditions = lines.filter(line => line.startsWith('#EXT-X-MEDIA:')).map(attrs);
    const variants = [];
    for (const [i, line] of lines.entries()) {
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = attrs(line);
      const sound = rendition(a.AUDIO, 'AUDIO', renditions);
      const image = rendition(a.VIDEO, 'VIDEO', renditions);
      if ((a.AUDIO && !sound) || (a.VIDEO && !image)) continue;
      if (!a.RESOLUTION && a.CODECS?.split(',').every(codec => /^(?:mp4a|aac|ac-3|ec-3|opus|flac)/i.test(codec.trim()))) continue;
      if (!lines[i + 1] || lines[i + 1].startsWith('#')) throw new Error('画質別の配信URLが見つかりません。');
      const main = resolveUri(lines[i + 1], base);
      const url = image?.URI ? resolveUri(image.URI, base) : main;
      const audioUrl = sound?.URI ? resolveUri(sound.URI, base) : main;
      const variant = { url, bandwidth: Number(a.BANDWIDTH) || 0, resolution: a.RESOLUTION || '' };
      if (audioUrl !== url) variant.audio = { url: audioUrl, name: sound?.NAME || sound?.LANGUAGE || '' };
      variants.push(variant);
    }
    if (!variants.length) throw new Error('マスターに保存できる映像の組み合わせが見つかりません。');
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const members = new Set(variants.map(variant => variant.url));
    function noteMember(uri) {
      if (!uri || uri.includes('{$')) return;
      const resolved = httpUrl(uri, base);
      if (resolved) members.add(resolved.href);
    }
    for (const rendition of renditions) noteMember(rendition.URI);
    for (const [i, line] of lines.entries()) {
      if (line.startsWith('#EXT-X-STREAM-INF:') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
        noteMember(lines[i + 1]);
      }
    }
    return { variant: variants[0], variants, members };
  }
  const live = !lines.includes('#EXT-X-ENDLIST') && !lines.includes('#EXT-X-PLAYLIST-TYPE:VOD');
  const targetDuration = playlistInteger(lines, 'TARGETDURATION', 0);
  const sequence = playlistInteger(lines, 'MEDIA-SEQUENCE', 0);
  let discontinuity = playlistInteger(lines, 'DISCONTINUITY-SEQUENCE', 0);
  if (live && !targetDuration) throw new Error('ライブHLSの更新間隔が分かりません。');
  if (lines.some(line => /^#EXT-X-(?:I-FRAMES-ONLY$|SKIP:)/.test(line))) {
    throw new Error('このHLSには完全な動画区間の一覧がありません。');
  }
  const parts = [];
  let init, range, pendingDuration, programTime, gap = false, duration = 0;
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line);
      init = makePart(a.URI, a.BYTERANGE, base);
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity++;
      programTime = undefined;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const date = Date.parse(line.slice(line.indexOf(':') + 1));
      programTime = Number.isFinite(date) ? date / 1000 : undefined;
    } else if (line === '#EXT-X-GAP') {
      gap = true;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      range = line.slice(line.indexOf(':') + 1);
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number(line.slice(8).split(',')[0]);
      if (!Number.isFinite(pendingDuration) || pendingDuration < 0) throw new Error('HLSの区間長が不正です。');
    } else if (!line.startsWith('#')) {
      if (pendingDuration === undefined) throw new Error('HLSの区間情報が不足しています。');
      parts.push({ ...makePart(line, range, base, parts.at(-1)), duration: pendingDuration, init, discontinuity, gap, programTime });
      if (programTime !== undefined) programTime += pendingDuration;
      duration += pendingDuration;
      pendingDuration = range = undefined;
      gap = false;
    }
  }
  if (!parts.length || pendingDuration !== undefined || range !== undefined) throw new Error('HLSの区間一覧が不完全です。');
  if (!Number.isSafeInteger(sequence + parts.length)) throw new Error('HLSの区間番号が大きすぎます。');
  if (!live && !followingLive) parts.forEach((part, index) => checkSegment(part, parts[index - 1], allowGaps, true));
  return { parts, init: parts[0].init, duration, live, sequence, targetDuration, extension: parts[0].init ? 'mp4' : 'ts' };
}

function connectionError(url) {
  const error = new Error(new URL(url).host + ' に接続できません。配信元のアクセス制限または通信状況を確認してください。');
  error.retryable = true;
  return error;
}

export function isSourceReadError(error) {
  return error.status === 401 || error.status === 403 || !!error.pageUnavailable || !!error.pageReadFailed;
}

async function request(url, options, stage, fetchResource = fetch, readableOrigins) {
  let response;
  try { response = await fetchResource(url, { credentials: 'omit', referrerPolicy: 'no-referrer', ...options }); }
  catch (error) {
    if (options.signal?.aborted || error.pageUnavailable || error.pageReadFailed || error.origins) throw error;
    throw connectionError(url);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    const host = new URL(response.url || url).host;
    const denied = response.status === 401 || response.status === 403;
    const route = response.fromPlayer ? 'プレーヤー経由' : '拡張から直接';
    const error = new Error(host + (denied ? ' が' + stage + 'の取得を拒否しました' : ' から' + stage + 'を取得できませんでした') + '（HTTP ' + response.status + '・' + route + '）。');
    error.status = response.status;
    error.httpResponse = true;
    if (response.pageUnavailable || (response.status === 403 && response.detachedOrigin && !readableOrigins?.has(response.detachedOrigin))) {
      error.pageUnavailable = true;
    }
    error.retryable = [404, 408, 429].includes(response.status) || response.status >= 500;
    throw error;
  }
  return response;
}

async function checkRedirect(response, url, checkAccess) {
  if (!checkAccess || new URL(response.url).origin === new URL(url).origin) return;
  try { await checkAccess([response.url]); }
  catch (error) { await response.body.cancel(); throw error; }
}

async function readPlaylist(url, checkAccess, signal, followingLive = false, fetchResource, stage = 'プレイリスト', allowGaps = false) {
  await checkAccess([url]);
  const response = await request(url, { signal, cache: 'no-store' }, stage, fetchResource);
  await checkRedirect(response, url, checkAccess);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', size = 0;
  for (;;) {
    const { value, done } = await readChunk(reader, url, signal);
    if (done) break;
    size += value.length;
    if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('プレイリストが大きすぎます。'); }
    text += decoder.decode(value, { stream: true });
  }
  return parsePlaylist(text + decoder.decode(), response.url, followingLive, allowGaps);
}

// Called only after a toolbar click. A master and its observed renditions are one choice.
export async function commonMaster(urls, checkAccess, fetchResource) {
  if (urls.length < 2 || urls.length > 32) return null;
  const named = urls.filter(url => /(?:master|multivariant)/i.test(new URL(url).pathname.split('/').pop()));
  const index = urls.find(url => /^(?:index|manifest|playlist)(?:\.m3u8)?$/i.test(new URL(url).pathname.split('/').pop()));
  const candidates = [...new Set([named[0], urls[0], index, named[1]].filter(Boolean))].slice(0, 3);
  const signal = AbortSignal.timeout(2000);
  for (const url of candidates) {
    try {
      const { members } = await readPlaylist(url, checkAccess, signal, false, fetchResource);
      if (members && urls.every(candidate => candidate === url || members.has(candidate))) return url;
    } catch { /* Keep the chooser when the relationship is unknown. */ }
  }
  return null;
}

function checkSegment(part, previous, allowGaps = false, archive = false) {
  if (previous && (part.discontinuity !== previous.discontinuity || !samePart(part.init, previous.init))) {
    throw new Error('映像・音声の切り替え区間に達しました。');
  }
  if (part.gap && !allowGaps) throw Object.assign(new Error('配信元が欠落区間を通知しました。'), {canSkip:archive});
}

async function checkPartAccess(parts, checkAccess, skipDeclared = false) {
  const origins = new Set();
  for (const part of parts) {
    if (!skipDeclared || !part.gap) origins.add(new URL(part.url).origin);
    if (part.init) origins.add(new URL(part.init.url).origin);
  }
  await checkAccess([...origins]);
}

export function loadJobPlan(job, checkAccess, signal, fetchResource, allowGaps = false) {
  const source = job.playbackResolution && job.pageSources?.find(s =>
    s.playlistUrl === job.url && s.tabId === job.tabId && s.documentId);
  let playback;
  if (source) {
    const frame = job.pageSources.filter(s => s.tabId === source.tabId && s.documentId === source.documentId);
    playback = { resolution: job.playbackResolution, urls: new Set(frame.map(s => s.playlistUrl)) };
  }
  return loadPlan(job.url, checkAccess, signal, job.audioUrl, fetchResource, playback, allowGaps);
}

export async function loadPlan(url, checkAccess, signal = new AbortController().signal, audioUrl, fetchResource, playback, allowGaps = false) {
  const seen = new Set();
  const read = (uri, stage) => retryTransient(() => readPlaylist(uri, checkAccess, signal, false, fetchResource, stage, allowGaps), signal);
  let resolution = '', sound = audioUrl ? { url: resolveUri(audioUrl, url), name: '指定した音声' } : null;
  while (!seen.has(url) && seen.size < 8) {
    seen.add(url);
    const plan = await read(url, seen.size === 1 ? 'プレイリスト' : '映像プレイリスト');
    if (!plan.variant) {
      await checkPartAccess(plan.parts, checkAccess, allowGaps && !plan.live);
      const video = { ...plan, resolution, playlistUrl: url };
      if (!sound) return video;
      const audio = await read(sound.url, '音声プレイリスト');
      if (audio.variant) throw new Error('別配信の音声プレイリストに区間一覧がありません。');
      await checkPartAccess(audio.parts, checkAccess, allowGaps && !audio.live);
      audio.playlistUrl = sound.url;
      audio.audioRendition = true;
      return { video, audio, audioName: sound.name, resolution, live: video.live || audio.live,
        duration: Math.min(video.duration, audio.duration) };
    }
    let variant = plan.variant;
    if (playback && [...playback.urls].every(uri => uri === url || plan.members.has(uri))) {
      const matches = plan.variants.filter(candidate =>
        candidate.resolution === playback.resolution && playback.urls.has(candidate.url));
      if (matches.length === 1) variant = matches[0];
    }
    resolution = variant.resolution || resolution;
    if (!audioUrl) sound = variant.audio || sound;
    url = variant.url;
  }
  throw new Error('HLSプレイリストの参照を解決できません。');
}

function checkHeader(bytes, format) {
  if (['ts', 'audio'].includes(format) && bytes.length >= 188 && bytes[0] === 0x47 && (bytes.length === 188 || bytes[188] === 0x47)) return 'ts';
  if (format === 'audio' && ((bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) ||
      (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33))) return 'aac';
  throw Object.assign(new Error('受信データが想定する動画形式と一致しません。保存を中止しました。'), {invalidMedia:true});
}

async function readChunk(reader, url, signal) {
  try { return await reader.read(); }
  catch (error) {
    if (signal?.aborted || error.pageUnavailable || error.pageReadFailed) throw error;
    throw connectionError(url);
  }
}

async function copyPart(part, format, writer, signal, checkAccess, fetchResource, audio, partStart, readableOrigins) {
  const ranged = part.start !== undefined;
  const headers = ranged ? { Range: 'bytes=' + part.start + '-' + part.end } : {};
  const stage = format === 'init' ? '初期化データ' : audio ? '音声区間' : '動画区間';
  const response = await request(part.url, { headers, signal }, stage, fetchResource, readableOrigins);
  await checkRedirect(response, part.url, checkAccess);
  const reader = response.body.getReader();
  try {
    if (ranged) {
      const range = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(response.headers.get('content-range') || '');
      if (response.status !== 206 || !range || +range[1] !== part.start || +range[2] !== part.end) throw new Error('配信元が指定範囲の動画データを返しませんでした。');
    } else if (response.status !== 200) throw new Error('配信元から完全な区間を取得できませんでした。');
    const boxes = format === 'init' || format === 'mp4' ? mp4BoxReader(format) : null;
    const prefix = boxes ? null : new Uint8Array(189);
    let used = 0, total = 0, detected;
    for (;;) {
      const { value, done } = await readChunk(reader, part.url, signal);
      if (done) break;
      total += value.byteLength;
      if (boxes || detected) {
        boxes?.push(value, total - value.byteLength);
        await writer.write(value);
        continue;
      }
      const n = Math.min(prefix.length - used, value.length);
      prefix.set(value.subarray(0, n), used);
      used += n;
      if (used === prefix.length) {
        detected = checkHeader(prefix, format);
        await writer.write(prefix);
        if (value.length > n) await writer.write(value.subarray(n));
      }
    }
    const openEndedAt = boxes?.finish();
    if (!boxes && !detected) {
      detected = checkHeader(prefix.subarray(0, used), format);
      await writer.write(prefix.subarray(0, used));
    }
    const length = response.headers.get('content-length');
    let expected = null;
    if (ranged) expected = part.end - part.start + 1;
    else if (length !== null && !response.headers.has('content-encoding')) expected = Number(length);
    if ((expected !== null && total !== expected) || (detected === 'ts' && total % 188 !== 0)) throw incompletePart();
    const openEndedSize = openEndedAt === undefined ? 0 : total - openEndedAt;
    if (openEndedSize && openEndedSize <= 0xffffffff) {
      // "To end of file" in a standalone segment must stop before the next appended segment.
      const lengthBytes = new Uint8Array(4);
      new DataView(lengthBytes.buffer).setUint32(0, openEndedSize);
      await writer.write({type:'write', position:partStart + openEndedAt, data:lengthBytes});
      await writer.seek(partStart + total);
    }
    if (readableOrigins) {
      if (response.detachedOrigin) readableOrigins.add(response.detachedOrigin);
      else readableOrigins.clear();
    }
    return {total, extendsToFileEnd:openEndedSize > 0xffffffff};
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function partWriter(writer, signal, checkAccess, fetchResource, audio, resolution) {
  let position = 0, extendsToFileEnd = false;
  // Only a complete direct media segment from this rendition establishes that
  // its origin is readable after the player disconnects.
  const readableOrigins = new Set();
  const quality = /^\d{1,6}x\d{1,6}$/.test(resolution) ? ' 取得画質 ' + resolution.replace('x', '×') + '。' : '';
  return async (part, format, segment) => {
    if (extendsToFileEnd) throw new Error('長さが未指定で4 GiB以上のMP4ボックスの後に、次の区間を連結できません。');
    try {
      const result = await retryTransient(() => copyPart(part, format, writer, signal, checkAccess, fetchResource, audio, position,
        segment ? readableOrigins : undefined), signal, () => writer.truncate(position));
      position += result.total;
      extendsToFileEnd = result.extendsToFileEnd;
      return result.total;
    } catch (error) {
      // A canceled sibling rendition can receive this same Error as its abort reason.
      if (segment && !signal.aborted && (error.status === 401 || error.status === 403)) {
        const ordinal = segment.total ? segment.number + '/' + segment.total : String(segment.number);
        const clock = segment.total ? '再生位置' : '取得開始から';
        error.message += ' ' + ordinal + ' 区間目（' + clock + ' ' + timeLabel(segment.start) + ' 付近）で停止しました。' + quality;
      }
      throw error;
    }
  };
}

async function partFingerprint(part) {
  const input = new TextEncoder().encode(JSON.stringify([part.url, part.start, part.end]));
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');
}

export async function writePlan(plan, writer, signal = new AbortController().signal, progress, checkAccess, fetchResource, track, previousFailure) {
  if (plan.live) throw new Error('ライブ配信はライブ保存を選んでください。');
  const format = plan.audioRendition && !plan.init ? 'audio' : plan.extension;
  let bytes = 0, duration = 0;
  const fetchPart = partWriter(writer, signal, checkAccess, fetchResource, plan.audioRendition, plan.resolution);
  if (plan.init) bytes += await fetchPart(plan.init, 'init');
  if (track) track.initBytes = bytes;
  for (const [index, part] of plan.parts.entries()) {
    signal.throwIfAborted();
    checkSegment(part, plan.parts[index - 1], !!track, true);
    const number = index + 1, byteStart = bytes, audio = !!plan.audioRendition;
    let omit = part.gap;
    if (track && previousFailure?.number === number && previousFailure.audio === audio) {
      omit ||= previousFailure.key === await partFingerprint(part);
    }
    if (!omit) {
      try {
        bytes += await fetchPart(part, format, {number, total:plan.parts.length, start:duration});
      } catch (error) {
        // Only a listed media part may be omitted. Initialization, permissions, local writes and aborts remain fatal.
        if (signal.aborted || error.pageUnavailable || !(error.invalidMedia || error.httpResponse && [403,404,410].includes(error.status))) throw error;
        if (!track) {
          error.canSkip = true;
          error.skipSegment = {number, audio, key:await partFingerprint(part)};
          throw error;
        }
        await writer.truncate(byteStart);
        await writer.seek(byteStart);
      }
    }
    if (track) {
      track.segments.push({start:duration, end:duration + part.duration, byteStart, byteEnd:bytes});
      if (track.programTime === undefined && part.programTime !== undefined) track.programTime = part.programTime - duration;
    }
    duration += part.duration;
    progress(index + 1, bytes, duration, part);
  }
  if (track && bytes === track.initBytes) throw new Error('保存できるメディア区間がありません。');
  return bytes;
}

function delay(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function retryTransient(operation, signal, rollback) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (signal.aborted || !error.retryable || attempt >= 2) throw error;
      if (rollback) await rollback();
      await delay(500 * (attempt + 1), signal);
    }
  }
}

export async function writeLivePlan(preview, writer, signal, stopSignal, checkAccess, progress, fetchResource) {
  const format = preview.audioRendition && !preview.init ? 'audio' : preview.extension;
  const requests = new AbortController();
  const interrupt = () => requests.abort();
  signal.addEventListener('abort', interrupt);
  stopSignal.addEventListener('abort', interrupt);
  if (signal.aborted || stopSignal.aborted) interrupt();
  const io = requests.signal;
  let bytes = 0, count = 0, duration = 0;
  let next, previous;
  const rollback = () => writer.truncate(bytes);
  const fetchPart = partWriter(writer, io, checkAccess, fetchResource, preview.audioRendition, preview.resolution);
  try {
    for (;;) {
      const requestedAt = performance.now();
      // Refresh after the file picker too. Its preview may already be outside the live window.
      const current = await retryTransient(() => readPlaylist(preview.playlistUrl, checkAccess, io, true, fetchResource, 'ライブのプレイリスト'), io);
      if (current.variant || current.extension !== preview.extension) throw new Error('配信の形式が変わりました。');
      next ??= current.sequence;
      if (next < current.sequence) throw new Error('未取得の区間が配信元の公開範囲から外れました。');
      const pending = current.parts.slice(next - current.sequence);
      if (pending.length) await checkPartAccess(pending, checkAccess);
      for (const part of pending) {
        io.throwIfAborted();
        checkSegment(part, previous);
        if (!count && part.init) bytes += await fetchPart(part.init, 'init');
        bytes += await fetchPart(part, format, {number:count + 1, start:duration});
        count++;
        next++;
        duration += part.duration;
        previous = part;
        progress(count, bytes, duration, part);
      }
      if (!current.live) {
        if (current.sequence + current.parts.length < next) throw new Error('配信元の最終区間を確認できませんでした。');
        return { duration, count, bytes };
      }
      const interval = current.targetDuration * (pending.length ? 1000 : 500);
      await delay(Math.max(0, interval - (performance.now() - requestedAt)), io);
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (!count) {
      if (stopSignal.aborted) throw new Error('最初の区間の取得前に停止しました。');
      throw error;
    }
    await rollback();
    const result = { duration, count, bytes, interruption: stopSignal.aborted ? null : error.message };
    if (!stopSignal.aborted && isSourceReadError(error)) result.sourceReadError = true;
    return result;
  } finally {
    requests.abort();
    signal.removeEventListener('abort', interrupt);
    stopSignal.removeEventListener('abort', interrupt);
  }
}
