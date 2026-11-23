import * as loadedMp4 from './mp4.mjs';
import * as currentErrors from './mp4-merge-error.mjs';

// An open extension document keeps its modules when the unpacked files change.
// Queues from 1.6.11–12 check their original constructor with instanceof.
// Earlier queues have only the TS converter at this URL.
const errors = typeof loadedMp4.Mp4MergeError === 'function' && typeof loadedMp4.classifyMergeError === 'function'
  ? loadedMp4 : currentErrors;
export const {Mp4MergeError, classifyMergeError} = errors;
