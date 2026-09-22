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
