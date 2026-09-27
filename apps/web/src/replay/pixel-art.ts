/** Deterministic RGBA images drawn in code; renderers only upload them (no assets or fetches). */
export type PixelImage = { width: number; height: number; data: Uint8ClampedArray };
export type Rgb = readonly [number, number, number];

export const rgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
export const blank = (width: number, height: number): PixelImage => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
});

/** Writes one pixel; `wrap` keeps repeating tiles seamless across their edges. */
export function plot(
  image: PixelImage,
  x: number,
  y: number,
  colour: Rgb,
  alpha = 255,
  wrap = true,
) {
  const { width, height, data } = image;
  let px = Math.floor(x),
    py = Math.floor(y);
  if (wrap) {
    px = ((px % width) + width) % width;
    py = ((py % height) + height) % height;
  } else if (px < 0 || py < 0 || px >= width || py >= height) return;
  const i = (py * width + px) * 4;
  data.set([colour[0], colour[1], colour[2], alpha], i);
}
export const alphaAt = (image: PixelImage, x: number, y: number) =>
  image.data[(y * image.width + x) * 4 + 3] ?? 0;

/** FNV-1a text hash feeding mulberry32: a fixed display-only sequence, never combat randomness. */
export function prng(text: string): () => number {
  let seed = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 0x01000193);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise on a lattice that repeats every `size` pixels. */
function periodicNoise(random: () => number, size: number, cells: number) {
  const lattice = Array.from({ length: cells * cells }, random);
  const at = (i: number, j: number) =>
    lattice[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)]!;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const fx = (x / size) * cells,
      fy = (y / size) * cells;
    const i = Math.floor(fx),
      j = Math.floor(fy);
    const tx = smooth(fx - i),
      ty = smooth(fy - j);
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
    return top + (bottom - top) * ty;
  };
}
const pick = <T>(random: () => number, values: readonly T[]): T =>
  values[Math.floor(random() * values.length)]!;
const ramp = (hexes: readonly string[]) => hexes.map(rgb);

const GRASS = ramp(['#223f1d', '#2c5224', '#37662b', '#447a32', '#5b953d']);
const DIRT = ramp(['#4a3421', '#5d432a', '#735535', '#8a6841']);
const STONE = ramp(['#4a4d53', '#5c6067', '#6c7077', '#7d8189', '#9296a0']);
const MOSS = ramp(['#35572b', '#437034', '#58893f']);
const WOOD = ramp(['#4d311b', '#6a4527', '#7d5330', '#90633a']);
const METAL = ramp(['#3b424c', '#58616d', '#6f7985', '#8b95a2', '#b3bcc8']);
const FLOWERS = ramp(['#f2d45c', '#f3eee0', '#e07aa5', '#86bff0']);
const MORTAR = rgb('#26272c');

export type TerrainKind =
  | 'grass'
  | 'dirt'
  | 'flagstone'
  | 'bricks'
  | 'mossy-bricks'
  | 'planks'
  | 'plates'
  | 'earth-wall';

function fillNoise(
  image: PixelImage,
  random: () => number,
  palette: readonly Rgb[],
  cells: readonly [number, number],
) {
  const coarse = periodicNoise(random, image.width, cells[0]),
    fine = periodicNoise(random, image.width, cells[1]);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const v = coarse(x, y) * 0.65 + fine(x, y) * 0.25 + random() * 0.1;
      plot(image, x, y, palette[Math.min(palette.length - 1, Math.floor(v * palette.length))]!);
    }
}

function grass(image: PixelImage, random: () => number) {
  const { width } = image;
  fillNoise(image, random, GRASS.slice(1, 4), [4, 16]);
  for (let n = 0; n < (width * width) / 40; n++) {
    const x = Math.floor(random() * width),
      y = Math.floor(random() * width),
      tall = random() < 0.4;
    for (const dx of [0, 2]) {
      plot(image, x + dx, y + 2, GRASS[0]!);
      plot(image, x + dx, y + 1, GRASS[3]!);
      plot(image, x + dx, y, GRASS[4]!);
      if (tall && dx === 0) plot(image, x, y - 1, GRASS[4]!);
    }
  }
  for (let n = 0; n < width / 8; n++) {
    const x = Math.floor(random() * width),
      y = Math.floor(random() * width),
      petal = pick(random, FLOWERS);
    if (random() < 0.5) plot(image, x, y, petal);
    else {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const)
        plot(image, x + dx, y + dy, petal);
      plot(image, x, y, FLOWERS[0]!);
    }
  }
  pebbles(image, random, width / 16);
}

function pebbles(image: PixelImage, random: () => number, count: number) {
  for (let n = 0; n < count; n++) {
    const x = Math.floor(random() * image.width),
      y = Math.floor(random() * image.height);
    plot(image, x, y, STONE[3]!);
    plot(image, x + 1, y, STONE[2]!);
    plot(image, x, y + 1, STONE[0]!);
    plot(image, x + 1, y + 1, STONE[0]!);
    plot(image, x, y - 1, STONE[4]!);
  }
}

function dirt(image: PixelImage, random: () => number) {
  fillNoise(image, random, DIRT, [4, 12]);
  pebbles(image, random, image.width / 6);
  for (let n = 0; n < image.width / 10; n++) {
    let x = Math.floor(random() * image.width),
      y = Math.floor(random() * image.height);
    for (let k = 0; k < 5; k++) {
      plot(image, x, y, DIRT[0]!);
      x += random() < 0.5 ? 1 : 0;
      y += random() < 0.5 ? 1 : -1;
    }
  }
}

/** Irregular slabs from toroidal nearest-seed cells; grooves are the cell borders. */
function flagstone(image: PixelImage, random: () => number) {
  const { width } = image;
  const wrapped = (a: number, b: number) => Math.min(Math.abs(a - b), width - Math.abs(a - b));
  // Rejection sampling keeps seeds apart, so no two cells merge into one groove.
  const seeds: { x: number; y: number; shade: number }[] = [];
  for (let attempt = 0; attempt < 400 && seeds.length < 12; attempt++) {
    const x = random() * width,
      y = random() * width;
    if (seeds.every((s) => Math.hypot(wrapped(x, s.x), wrapped(y, s.y)) > width / 5))
      seeds.push({ x, y, shade: 1 + Math.floor(random() * 3) });
  }
  const cell = (x: number, y: number) => {
    const d = seeds
      .map((s, i) => ({ i, d: Math.hypot(wrapped(x, s.x), wrapped(y, s.y)) }))
      .sort((a, b) => a.d - b.d);
    return { index: d[0]!.i, edge: d[1]!.d - d[0]!.d };
  };
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const here = cell(x, y);
      if (here.edge < 1.3) {
        plot(image, x, y, random() < 0.15 ? MOSS[0]! : MORTAR);
        continue;
      }
      const shade = seeds[here.index]!.shade + (random() < 0.12 ? 1 : 0);
      const lit = cell(x - 1, y - 1).edge < 1.3;
      plot(image, x, y, STONE[Math.min(4, lit ? shade + 1 : shade)]!);
    }
}

function bricks(image: PixelImage, random: () => number, mossy: boolean) {
  const { width } = image,
    rowHeight = width / 8,
    brickWidth = width / 4;
  const moss = periodicNoise(random, width, 4);
  for (let row = 0; row < 8; row++) {
    const offset = row % 2 ? brickWidth / 2 : 0;
    for (let b = 0; b < 4; b++) {
      const shade = 1 + Math.floor(random() * 3),
        left = b * brickWidth + offset;
      for (let dy = 0; dy < rowHeight; dy++)
        for (let dx = 0; dx < brickWidth; dx++) {
          const x = left + dx,
            y = row * rowHeight + dy;
          const colour =
            dy === rowHeight - 1 || dx === brickWidth - 1
              ? MORTAR
              : dy === 0 || dx === 0
                ? STONE[shade + 1]!
                : dy === rowHeight - 2
                  ? STONE[shade - 1]!
                  : random() < 0.08
                    ? STONE[shade - 1]!
                    : STONE[shade]!;
          plot(image, x, y, colour);
          if (mossy && colour !== MORTAR && moss(x, y) > 0.62)
            plot(image, x, y, MOSS[moss(x, y) > 0.7 ? 2 : random() < 0.5 ? 1 : 0]!);
        }
    }
  }
}

function planks(image: PixelImage, random: () => number) {
  const { width } = image,
    rowHeight = width / 8;
  for (let row = 0; row < 8; row++) {
    const shade = 1 + Math.floor(random() * 3),
      seam = Math.floor(random() * width);
    for (let dy = 0; dy < rowHeight; dy++)
      for (let x = 0; x < width; x++) {
        const y = row * rowHeight + dy;
        const colour =
          dy === rowHeight - 1 || x === seam
            ? WOOD[0]!
            : dy === 0
              ? WOOD[Math.min(3, shade + 1)]!
              : random() < 0.1
                ? WOOD[shade - 1]!
                : WOOD[shade]!;
        plot(image, x, y, colour);
      }
    for (const x of [seam + 2, seam - 3]) plot(image, x, row * rowHeight + 3, METAL[3]!);
  }
}

function plates(image: PixelImage, random: () => number) {
  const { width } = image,
    panel = width / 2;
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const px = x % panel,
        py = y % panel;
      const colour =
        px === panel - 1 || py === panel - 1
          ? METAL[0]!
          : px === 0 || py === 0
            ? METAL[4]!
            : METAL[3 - Math.min(2, Math.floor((py / panel) * 3))]!;
      plot(image, x, y, random() < 0.04 ? METAL[1]! : colour);
    }
  for (let y = 0; y < width; y += panel)
    for (let x = 0; x < width; x += panel)
      for (const [dx, dy] of [
        [3, 3],
        [panel - 4, 3],
        [3, panel - 4],
        [panel - 4, panel - 4],
      ] as const) {
        plot(image, x + dx, y + dy, METAL[4]!);
        plot(image, x + dx + 1, y + dy + 1, METAL[0]!);
      }
}

function earthWall(image: PixelImage, random: () => number) {
  const { width } = image;
  const strata = periodicNoise(random, width, 4);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const band = (y / width) * 6 + strata(x, y) * 2.2;
      plot(image, x, y, DIRT[Math.floor(band) % 3]!);
    }
  for (let n = 0; n < width / 6; n++) {
    const x = Math.floor(random() * width),
      y = Math.floor(random() * width),
      size = 1 + Math.floor(random() * 3);
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx <= size; dx++)
        plot(image, x + dx, y + dy, STONE[dy === 0 ? 3 : dy === size - 1 ? 0 : 2]!);
  }
  for (let n = 0; n < width / 16; n++) {
    let x = Math.floor(random() * width),
      y = Math.floor(random() * width);
    for (let k = 0; k < 9; k++) {
      plot(image, x, y, WOOD[0]!);
      y += 1;
      x += random() < 0.3 ? 1 : random() < 0.3 ? -1 : 0;
    }
  }
}

/** A seamless terrain tile; the same kind always yields the same pixels. */
export function terrainTile(kind: TerrainKind, size = 64): PixelImage {
  const image = blank(size, size),
    random = prng(`terrain:${kind}:${size}`);
  if (kind === 'grass') grass(image, random);
  else if (kind === 'dirt') dirt(image, random);
  else if (kind === 'flagstone') flagstone(image, random);
  else if (kind === 'bricks' || kind === 'mossy-bricks')
    bricks(image, random, kind === 'mossy-bricks');
  else if (kind === 'planks') planks(image, random);
  else if (kind === 'plates') plates(image, random);
  else earthWall(image, random);
  return image;
}

/**
 * Large-scale meadow variation in linear channels: red marks dirt clearings and green shifts
 * brightness. Sampled in world space, it breaks up the repetition of the small tiles.
 */
export function meadowMask(size = 128): PixelImage {
  const image = blank(size, size),
    random = prng(`meadow:${size}`);
  const coarse = periodicNoise(random, size, 6),
    detail = periodicNoise(random, size, 16),
    light = periodicNoise(random, size, 5);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      plot(image, x, y, [
        Math.round((coarse(x, y) * 0.78 + detail(x, y) * 0.22) * 255),
        Math.round(light(x, y) * 255),
        0,
      ]);
  return image;
}

export type GlowKind = 'soft' | 'burst' | 'ring' | 'runes';

/** Signed distance from a point to a segment, in the same unit as the inputs. */
const toSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const vx = bx - ax,
    vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
};

function runeCoverage(r: number, angle: number, x: number, y: number) {
  if ((r > 0.86 && r < 0.95) || (r > 0.6 && r < 0.66)) return 1;
  // Eight glyph ticks between the rings, alternating long and short.
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8,
      long = k % 2 === 0;
    if (
      Math.abs(Math.atan2(Math.sin(angle - a), Math.cos(angle - a))) < 0.07 &&
      r > (long ? 0.68 : 0.74) &&
      r < 0.84
    )
      return 1;
  }
  // Hexagram inside the inner ring.
  const points = Array.from({ length: 6 }, (_, k) => [
    0.6 * Math.cos((k * Math.PI) / 3 - Math.PI / 2),
    0.6 * Math.sin((k * Math.PI) / 3 - Math.PI / 2),
  ]);
  for (let k = 0; k < 6; k++) {
    const a = points[k]!,
      b = points[(k + 2) % 6]!;
    if (toSegment(x, y, a[0]!, a[1]!, b[0]!, b[1]!) < 0.03) return 0.85;
  }
  return 0;
}

/**
 * White RGB with the shape in alpha, quantised to a few bands like hand-drawn pixel glows.
 * Materials tint them, so one texture serves every element colour.
 */
export function glowTexture(kind: GlowKind, size = 32): PixelImage {
  const image = blank(size, size),
    white: Rgb = [255, 255, 255];
  const bands = (v: number, steps: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * steps) / steps;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 - 1,
        y = ((py + 0.5) / size) * 2 - 1;
      const r = Math.hypot(x, y),
        angle = Math.atan2(y, x);
      let v = 0;
      if (kind === 'soft') v = bands((1 - r) ** 1.5, 5);
      else if (kind === 'burst') {
        const rays = Math.max(
          Math.abs(Math.cos(2 * angle)) ** 24,
          0.6 * Math.abs(Math.sin(2 * angle)) ** 24,
        );
        v = bands(Math.max(Math.min(1, (1 - r / 0.36) * 1.6), rays * (1 - r) * 1.3), 4);
      } else if (kind === 'ring') v = bands(1 - Math.abs(r - 0.78) / 0.14, 3);
      else v = runeCoverage(r, angle, x, y);
      if (v > 0) plot(image, px, py, white, Math.round(v * 255), false);
    }
  return image;
}
