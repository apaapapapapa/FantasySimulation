/** Stable sensor-projection identity; this never consumes a participant PRNG stream. */
export function environmentalHologramId(
  seed: number,
  creatorId: string,
  observerId: string,
  emissionOrdinal: number,
) {
  let hash = (seed ^ 0x85ebca6b) >>> 0;
  for (const code of `${creatorId}\0${observerId}\0${emissionOrdinal}`) {
    hash ^= code.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `hologram.${seed.toString(16)}.${emissionOrdinal.toString(16)}.${hash.toString(16)}`;
}

export function environmentalHologramOrdinal(id: string) {
  const match = /^hologram\.[0-9a-f]+\.([0-9a-f]+)\.[0-9a-f]+$/.exec(id);
  if (!match) return null;
  const ordinal = Number.parseInt(match[1]!, 16);
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : null;
}
