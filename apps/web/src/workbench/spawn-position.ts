import type { Revision } from '@fantasy/domain/spatial';

/** A local editor default, constrained by the selected body's size and arena. */
export function spawnPosition(character: Revision, scenario: Revision, index: number) {
  if (character.kind !== 'character' || scenario.kind !== 'scenario')
    throw new Error('キャラクターと戦場を選択してください');
  const { body } = character.definition;
  const { bounds } = scenario.definition;
  const position = {
    x: index === 0 ? -4000 : 4000,
    y: Math.max(1200, Math.ceil(body.heightMm / 2) + 20),
    z: 0,
  };
  for (const axis of ['x', 'y', 'z'] as const) {
    const extent = axis === 'y' ? body.heightMm / 2 : body.radiusMm;
    const low = Math.ceil(bounds.min[axis] + extent);
    const high = Math.floor(bounds.max[axis] - extent);
    if (low > high) throw new Error('選択したキャラクターが戦場の範囲に収まりません');
    position[axis] = Math.max(low, Math.min(high, position[axis]));
  }
  return position;
}
