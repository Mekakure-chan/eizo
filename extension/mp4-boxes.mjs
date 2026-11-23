const firstBoxes = {init:['ftyp','moov','free'], mp4:['styp','sidx','moof','emsg','prft','free']};

export function incompletePart() {
  return Object.assign(new Error('配信元の区間データが途中で終了しました。'), { retryable:true, invalidMedia:true });
}

// Check top-level box boundaries as bytes arrive. Only the current header is buffered.
export function mp4BoxReader(format) {
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  const wholeFile = format === 'file';
  let filled = 0, headerSize = 8, remaining = 0, first = true;
  let hasMovie = false, hasFragment = false, hasData = false, needsData = false;
  let openEndedAt;
  return {
    push(bytes, blockOffset) {
      let offset = 0;
      while (offset < bytes.length) {
        if (remaining > 0) {
          const count = Math.min(remaining, bytes.length - offset);
          remaining -= count;
          offset += count;
          continue;
        }
        const count = Math.min(headerSize - filled, bytes.length - offset);
        header.set(bytes.subarray(offset, offset + count), filled);
        offset += count;
        filled += count;
        if (filled < headerSize) continue;
        let size = view.getUint32(0);
        if (size === 1 && headerSize === 8) { headerSize = 16; continue; }
        const type = String.fromCharCode(...header.subarray(4, 8));
        if (first && !wholeFile && !firstBoxes[format].includes(type)) {
          throw Object.assign(new Error('受信データが想定する動画形式と一致しません。保存を中止しました。'), {invalidMedia:true});
        }
        first = false;
        if (headerSize === 16) size = Number(view.getBigUint64(8));
        else if (size === 0) {
          openEndedAt = blockOffset + offset - headerSize;
          size = Infinity;
        }
        if (size !== Infinity && (!Number.isSafeInteger(size) || size < headerSize)) {
          throw Object.assign(new Error('MP4の区間データに不正なボックス長があります。'), {invalidMedia:true});
        }
        if (type === 'moov') hasMovie = true;
        if (type === 'moof') {
          if (!wholeFile && needsData) throw incompletePart();
          hasFragment = needsData = true;
        } else if (type === 'mdat') {
          if (size > headerSize) hasData = true;
          needsData = false;
        }
        remaining = size - headerSize;
        filled = 0;
        headerSize = 8;
      }
    },
    finish() {
      const truncated = filled || (remaining && remaining !== Infinity);
      if (wholeFile) {
        if (truncated || !hasMovie || !hasData) throw new Error('MP4の内部データが不足しているため、保存できません。');
      } else if (truncated || (format === 'init' ? !hasMovie : !hasFragment || needsData)) throw incompletePart();
      return openEndedAt;
    }
  };
}
