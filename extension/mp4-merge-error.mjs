export class Mp4MergeError extends Error {
  name = 'Mp4MergeError';
}

// A failed attempt from an older extension can still be visible in a newly opened queue.
export function mp4StatusText({phase,text}) {
  if (!['failed','interrupted','ready'].includes(phase) ||
      !/The requested module '\.\/mp4\.mjs' does not provide an export named '(?:Mp4MergeError|classifyMergeError)'/.test(text)) return text;
  const action = phase === 'ready' ? 'もう一度保存してください。' : '「再取得」を押してください。';
  return '拡張のMP4結合処理を読み込めませんでした。ほかの動画の取得・保存が終わったら、' + action;
}

// Only known media validation errors are terminal. Disk errors and cancellation
// can pass through the same muxer and must keep their original recovery behavior.
export function classifyMergeError(error) {
  if (error?.name === 'UnsupportedInputFormatError') {
    return new Mp4MergeError('取得したデータの形式を読み取れません。', {cause:error});
  }
  // Mediabunny 1.66.2 reports packet-order violations as plain Errors.
  if (error?.name !== 'Error') return error;
  if (error.message?.startsWith('Timestamps cannot be smaller than the largest timestamp of the previous GOP')) {
    return new Mp4MergeError('区間の再生時刻が前後しており、1本のMP4にまとめられません。', {cause:error});
  }
  if (error.message === 'First packet must be a key packet.') {
    return new Mp4MergeError('区間の先頭に再生を開始できるキーフレームがありません。', {cause:error});
  }
  return error;
}
