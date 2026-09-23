import type { Revision } from '@fantasy/domain/spatial';

/** Place both bodies relative to the arena, keeping a gap without running physics in the UI. */
export function spawnPositions(characters: readonly [Revision, Revision], scenario: Revision) {
  if (scenario.kind !== 'scenario') throw new Error('戦場を選択してください');
  const bodies = characters.map((character) => {
    if (character.kind !== 'character') throw new Error('キャラクターを選択してください');
    return character.definition.body;
  });
  const { bounds } = scenario.definition;
  const positions = bodies.map((body) => {
    const position = {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: Math.max(1200, Math.ceil(body.heightMm / 2) + 20),
      z: (bounds.min.z + bounds.max.z) / 2,
    };
    for (const axis of ['x', 'y', 'z'] as const) {
      const extent = axis === 'y' ? body.heightMm / 2 : body.radiusMm;
      const low = Math.ceil(bounds.min[axis] + extent),
        high = Math.floor(bounds.max[axis] - extent);
      if (low > high) throw new Error('選択したキャラクターが戦場の範囲に収まりません');
      position[axis] = Math.max(low, Math.min(high, Math.round(position[axis])));
    }
    return position;
  });
  const minimumGap = bodies[0]!.radiusMm + bodies[1]!.radiusMm + 20;
  for (const axis of ['x', 'z'] as const) {
    const low = bounds.min[axis] + bodies[0]!.radiusMm,
      high = bounds.max[axis] - bodies[1]!.radiusMm;
    if (high - low < minimumGap) continue;
    const gap = Math.min(high - low, Math.max(8000, minimumGap));
    positions[0]![axis] = Math.floor((low + high - gap) / 2);
    positions[1]![axis] = Math.ceil((low + high + gap) / 2);
    return positions;
  }
  throw new Error('2体を離して配置できません。広い戦場を選択してください');
}
