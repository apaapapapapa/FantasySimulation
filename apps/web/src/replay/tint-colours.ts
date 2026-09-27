import type { Tint } from './scene-model.ts';

/** Bright core and outer glow per saved ability tint; untinted marks use the physical pair. */
export const TINT_COLOURS: Record<Tint, { core: string; glow: string }> = {
  physical: { core: '#fff4d6', glow: '#ffbf57' },
  fire: { core: '#fff0c2', glow: '#ff6a2b' },
  ice: { core: '#f2fdff', glow: '#6fd6ff' },
  lightning: { core: '#fffde0', glow: '#ffe44d' },
  arcane: { core: '#fbeaff', glow: '#c070ff' },
  water: { core: '#e8f6ff', glow: '#3d9bff' },
  earth: { core: '#fff1d0', glow: '#c99443' },
  heal: { core: '#eeffe8', glow: '#57e07a' },
  shield: { core: '#f4f8ff', glow: '#9fb8ff' },
};
export const tintColours = (tint: Tint | null) => TINT_COLOURS[tint ?? 'physical'];
