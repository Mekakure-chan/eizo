// Only the extension's own media modules can get out of sync during an unpacked update.
const mediaModule = /^(?:mp4(?:-duration|-track-time)?|mp4-merge-(?:error|compat)|(?:paired|gapped)-mp4|queue-(?:transfer|files)|media|renditions|hls|vendor\/mediabunny-[\d.]+)\.mjs$/;

export function isUpdateModuleError(text, base) {
  if (typeof text !== 'string') return false;
  const missing = /^The requested module '([^']+)' does not provide an export named '[\w$]+'$/.exec(text);
  if (missing?.[1].startsWith('./')) return mediaModule.test(missing[1].slice(2));
  const prefix = 'Failed to fetch dynamically imported module: ';
  if (!missing && !text.startsWith(prefix)) return false;
  base ??= globalThis.chrome?.runtime?.getURL?.('');
  const url = missing ? missing[1] : text.slice(prefix.length);
  return !!base && url.startsWith(base) && mediaModule.test(url.slice(base.length));
}

export const blocksUpdateRetry = (phase, folderSavePending = false) => ['queued','fetching','recording','saveQueued','saving'].includes(phase) ||
  (phase === 'ready' && folderSavePending);

export function isAcquisitionUpdateFailure(page, state) {
  return ['hls','file'].includes(page?.job?.kind) && ['failed','interrupted'].includes(state?.phase) &&
    !state.output && isUpdateModuleError(state.text);
}
