/** Stable independent cue identity; it never consumes either participant's PRNG stream. */
export function sensoryCueId(
  seed: number,
  creatorId: string,
  observerId: string,
  emissionOrdinal: number,
) {
  let hash = (seed ^ 0x9e3779b9) >>> 0;
  for (const code of `${creatorId}\0${observerId}\0${emissionOrdinal}`) {
    hash ^= code.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `cue.${seed.toString(16)}.${emissionOrdinal.toString(16)}.${hash.toString(16)}`;
}
