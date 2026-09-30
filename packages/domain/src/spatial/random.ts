export function nextRandom(state: number): number {
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}
/** Stream belongs to the actor and travels with it when participants are exchanged. */
export function actorSeed(master: number, stream: 0 | 1): number {
  return ((master >>> 0) ^ Math.imul(0x9e3779b9, stream + 1)) >>> 0 || 0x6d2b79f5;
}

/** Stable dependent stream identity; enumeration and command order are deliberately absent. */
export function dependentSeed(
  master: number,
  ownerStream: 0 | 1,
  ordinal: number,
  entityId: string,
  purpose: string,
): number {
  let state = (actorSeed(master, ownerStream) ^ Math.imul(ordinal + 1, 0x85ebca6b)) >>> 0;
  for (const code of `${entityId}\0${purpose}`)
    state = Math.imul(state ^ code.charCodeAt(0), 0x01000193);
  return nextRandom(state >>> 0 || 0x6d2b79f5);
}
