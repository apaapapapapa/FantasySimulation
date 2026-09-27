import { describe, expect, it } from 'vite-plus/test';
import {
  alphaAt,
  glowTexture,
  meadowMask,
  prng,
  rgb,
  shade,
  terrainTile,
  type PixelImage,
  type TerrainKind,
} from './pixel-art.ts';

const KINDS: TerrainKind[] = [
  'grass',
  'dirt',
  'flagstone',
  'bricks',
  'mossy-bricks',
  'planks',
  'plates',
  'earth-wall',
];
const colours = (image: PixelImage) => {
  const seen = new Set<number>();
  for (let i = 0; i < image.data.length; i += 4)
    seen.add((image.data[i]! << 16) | (image.data[i + 1]! << 8) | image.data[i + 2]!);
  return seen;
};
const alphas = (image: PixelImage) => image.data.filter((_, i) => i % 4 === 3);

describe('terrain tiles', () => {
  it.each(KINDS)('draws a deterministic, opaque, textured %s tile', (kind) => {
    const tile = terrainTile(kind);
    expect([tile.width, tile.height]).toEqual([64, 64]);
    expect(terrainTile(kind).data).toEqual(tile.data);
    expect(alphas(tile).every((a) => a === 255)).toBe(true);
    expect(colours(tile).size).toBeGreaterThanOrEqual(4);
  });
  it('keeps kinds and sizes apart', () => {
    expect(terrainTile('grass').data).not.toEqual(terrainTile('dirt').data);
    const large = terrainTile('grass', 128);
    expect([large.width, large.height]).toEqual([128, 128]);
    expect(large.data.length).toBe(128 * 128 * 4);
  });
});

it('repeats one display sequence per text seed without touching combat randomness', () => {
  const take = (random: () => number) => Array.from({ length: 6 }, random);
  const values = take(prng('seed'));
  expect(take(prng('seed'))).toEqual(values);
  expect(take(prng('other'))).not.toEqual(values);
  expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
});

describe('glow textures', () => {
  it('stores the shape in alpha over white so materials can tint it', () => {
    for (const kind of ['soft', 'burst', 'ring', 'runes'] as const) {
      const image = glowTexture(kind);
      const tinted = [];
      for (let i = 0; i < image.data.length; i += 4)
        if (image.data[i + 3]) tinted.push([...image.data.slice(i, i + 3)].join());
      expect(tinted.length).toBeGreaterThan(0);
      expect(new Set(tinted)).toEqual(new Set(['255,255,255']));
      expect(alphaAt(image, 0, 0)).toBe(0);
    }
  });
  it('is brightest at the centre of soft glows and bursts, hollow inside rings', () => {
    const soft = glowTexture('soft'),
      burst = glowTexture('burst'),
      ring = glowTexture('ring');
    expect(alphaAt(soft, 16, 16)).toBe(255);
    expect(alphaAt(soft, 16, 16)).toBeGreaterThan(alphaAt(soft, 16, 26));
    // Burst rays run along the axes (and shorter ones along diagonals); the gaps are dark.
    expect(alphaAt(burst, 16, 16)).toBe(255);
    expect(alphaAt(burst, 16, 4)).toBeGreaterThan(alphaAt(burst, 27, 11));
    expect(alphaAt(ring, 16, 16)).toBe(0);
    expect(alphaAt(ring, 16, 3)).toBeGreaterThan(0);
  });
});

it('keeps meadow variation in the red and green data channels', () => {
  const mask = meadowMask(64);
  expect(meadowMask(64).data).toEqual(mask.data);
  const red = new Set<number>(),
    green = new Set<number>();
  for (let i = 0; i < mask.data.length; i += 4) {
    red.add(mask.data[i]!);
    green.add(mask.data[i + 1]!);
    expect([mask.data[i + 2], mask.data[i + 3]]).toEqual([0, 255]);
  }
  expect(red.size).toBeGreaterThan(20);
  expect(green.size).toBeGreaterThan(20);
});

it('shades a colour lighter toward yellow and darker toward violet', () => {
  const red = rgb('#e76669'),
    grey = rgb('#b5bfd1');
  expect(shade(red, 0)).toEqual(red);
  const luma = ([r, g, b]: readonly number[]) => 0.3 * r! + 0.59 * g! + 0.11 * b!;
  for (const colour of [red, grey, rgb('#64a7e4'), rgb('#76bfa0')]) {
    const tones = [-0.85, -0.45, 0, 0.45].map((amount) => shade(colour, amount));
    for (let i = 1; i < tones.length; i++)
      expect(luma(tones[i]!)).toBeGreaterThan(luma(tones[i - 1]!));
  }
  // Red highlights gain green (toward yellow); its shadows gain blue (toward violet).
  expect(shade(red, 0.45)[1] - shade(red, 0.45)[2]).toBeGreaterThan(red[1] - red[2]);
  expect(shade(red, -0.45)[2]).toBeGreaterThan(shade(red, -0.45)[1]);
});
