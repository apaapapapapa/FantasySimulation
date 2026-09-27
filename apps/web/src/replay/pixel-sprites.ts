import { blank, mix, plot, rgb, type PixelImage, type Rgb } from './pixel-art.ts';

export type Silhouette = 'humanoid' | 'beast' | 'construct' | 'winged' | 'amorphous';
export type Equipment = 'blade' | 'bow' | 'staff' | 'shield' | 'spear' | 'axe' | 'grimoire';
export type SpritePose =
  | 'idle'
  | 'step-a'
  | 'step-b'
  | 'attack'
  | 'recover'
  | 'cast'
  | 'jump'
  | 'crouch'
  | 'down'
  | 'dodge'
  | 'fly-a'
  | 'fly-b';
/** Recorded appearance (or the neutral fallback) plus the display tint for glowing parts. */
export type SpriteLook = {
  silhouette: Silhouette;
  colour: string;
  equipment: readonly Equipment[];
  glow: string;
};

export const SPRITE_SIZE = 32;
/** Pixel row of the feet; renderers anchor it to the bottom of the recorded body. */
export const SPRITE_FEET = 29;
/** Standing figure height in pixels (rows 5–29); renderers scale it to the body height. */
export const SPRITE_FIGURE = 25;

const S = {
  none: 0,
  outline: 1,
  base: 2,
  light: 3,
  dark: 4,
  skin: 5,
  skinDark: 6,
  hair: 7,
  leather: 8,
  leatherDark: 9,
  cloth: 10,
  metal: 11,
  metalDark: 12,
  gold: 13,
  wood: 14,
  glow: 15,
  white: 16,
} as const;
type Slot = (typeof S)[keyof typeof S];
type Point = readonly [number, number];

class Grid {
  readonly cells = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE);
  set(x: number, y: number, slot: Slot) {
    const px = Math.round(x),
      py = Math.round(y);
    if (px >= 0 && py >= 0 && px < SPRITE_SIZE && py < SPRITE_SIZE)
      this.cells[py * SPRITE_SIZE + px] = slot;
  }
  get(x: number, y: number) {
    return x >= 0 && y >= 0 && x < SPRITE_SIZE && y < SPRITE_SIZE
      ? this.cells[y * SPRITE_SIZE + x]!
      : S.none;
  }
  rect(x: number, y: number, w: number, h: number, slot: Slot) {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, slot);
  }
  line([x0, y0]: Point, [x1, y1]: Point, slot: Slot) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++)
      this.set(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, slot);
  }
  /** A two-pixel limb: the second row/column carries the shade. */
  limb(from: Point, to: Point, slot: Slot, shade: Slot) {
    const vertical = Math.abs(to[1] - from[1]) >= Math.abs(to[0] - from[0]);
    const [ox, oy] = vertical ? [1, 0] : [0, 1];
    this.line([from[0] + ox, from[1] + oy], [to[0] + ox, to[1] + oy], shade);
    this.line(from, to, slot);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, slot: (x: number, y: number) => Slot) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
        if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1)
          this.set(x, y, slot(x, y));
  }
}

type Rig = {
  bob: number;
  lean: number;
  frontHand: Point;
  backHand: Point;
  frontFoot: Point;
  backFoot: Point;
  knees?: readonly [Point, Point];
  /** Main weapon angle in degrees: 0 points forward, 90 points up. */
  weapon: number;
};
const RIGS: Record<Exclude<SpritePose, 'down'>, Rig> = {
  idle: {
    bob: 0,
    lean: 0,
    frontHand: [20, 18],
    backHand: [10, 18],
    frontFoot: [16, 26],
    backFoot: [13, 26],
    weapon: -60,
  },
  'step-a': {
    bob: 0,
    lean: 0,
    frontHand: [21, 17],
    backHand: [9, 18],
    frontFoot: [18, 26],
    backFoot: [11, 26],
    weapon: -50,
  },
  'step-b': {
    bob: 1,
    lean: 0,
    frontHand: [20, 18],
    backHand: [10, 17],
    frontFoot: [15, 26],
    backFoot: [14, 26],
    weapon: -65,
  },
  attack: {
    bob: 0,
    lean: 1,
    frontHand: [25, 13],
    backHand: [9, 16],
    frontFoot: [18, 26],
    backFoot: [11, 26],
    weapon: 35,
  },
  recover: {
    bob: 1,
    lean: 1,
    frontHand: [24, 19],
    backHand: [10, 17],
    frontFoot: [18, 26],
    backFoot: [12, 26],
    weapon: -25,
  },
  cast: {
    bob: 0,
    lean: 0,
    frontHand: [21, 6],
    backHand: [9, 6],
    frontFoot: [16, 26],
    backFoot: [13, 26],
    weapon: 90,
  },
  jump: {
    bob: -3,
    lean: 0,
    frontHand: [22, 14],
    backHand: [8, 14],
    frontFoot: [18, 23],
    backFoot: [14, 24],
    knees: [
      [19, 20],
      [15, 21],
    ],
    weapon: 20,
  },
  crouch: {
    bob: 4,
    lean: 1,
    frontHand: [22, 21],
    backHand: [10, 21],
    frontFoot: [18, 26],
    backFoot: [12, 26],
    knees: [
      [20, 24],
      [15, 24],
    ],
    weapon: 5,
  },
  dodge: {
    bob: 1,
    lean: -2,
    frontHand: [18, 17],
    backHand: [7, 15],
    frontFoot: [17, 26],
    backFoot: [9, 26],
    weapon: -75,
  },
  'fly-a': {
    bob: -1,
    lean: 0,
    frontHand: [23, 15],
    backHand: [7, 15],
    frontFoot: [16, 26],
    backFoot: [14, 27],
    weapon: -35,
  },
  'fly-b': {
    bob: 0,
    lean: 0,
    frontHand: [21, 18],
    backHand: [9, 18],
    frontFoot: [16, 27],
    backFoot: [14, 26],
    weapon: -55,
  },
};

const MAIN: readonly Equipment[] = ['blade', 'axe', 'spear', 'staff', 'bow'];

/** Main weapon from the hand along `angle`; `lit` adds the cast glow to staves. */
function weapon(g: Grid, item: Equipment, hand: Point, angle: number, pose: SpritePose) {
  const a = (angle * Math.PI) / 180,
    dx = Math.cos(a),
    dy = -Math.sin(a);
  const at = (t: number, side = 0): Point => [
    hand[0] + dx * t - dy * side,
    hand[1] + dy * t + dx * side,
  ];
  if (item === 'blade') {
    g.line(at(-2), at(-1), S.gold);
    g.line(at(1, -1), at(1, 1), S.gold);
    g.line(at(2), at(8), S.metal);
    g.set(...at(9), S.white);
  } else if (item === 'axe') {
    g.line(at(-2), at(7), S.wood);
    for (let t = 5; t <= 7; t++) g.line(at(t, 0), at(t, 3), t === 7 ? S.metalDark : S.metal);
  } else if (item === 'spear') {
    g.line(at(-6), at(8), S.wood);
    g.line(at(9), at(11), S.metal);
    g.set(...at(12), S.white);
  } else if (item === 'staff') {
    g.line(at(-7), at(6), S.wood);
    const [ox, oy] = at(8);
    g.ellipse(ox, oy, 1.6, 1.6, () => S.glow);
    g.set(ox - 0.5, oy - 0.5, S.white);
    if (pose === 'cast')
      for (const [sx, sy] of [
        [-3, -2],
        [3, -1],
        [0, -4],
      ] as const)
        g.set(ox + sx, oy + sy, S.glow);
  } else {
    // Bow: a bent limb across the hand; the attack pose draws the string back with an arrow.
    const pulled = pose === 'attack';
    const tips: Point[] = [];
    for (let t = -5; t <= 5; t++) {
      const bend = 2 - (t * t) / 12.5;
      const p: Point = [hand[0] + dx * bend - dy * t, hand[1] + dy * bend + dx * t];
      g.set(...p, S.wood);
      if (Math.abs(t) === 5) tips.push(p);
    }
    const nock: Point = pulled ? at(-3) : at(0);
    g.line(tips[0]!, nock, S.white);
    g.line(nock, tips[1]!, S.white);
    if (pulled) {
      g.line(nock, at(7), S.wood);
      g.set(...at(8), S.metal);
    }
  }
}

function offHand(g: Grid, item: Equipment, hand: Point, pose: SpritePose) {
  const [x, y] = hand;
  if (item === 'shield') {
    g.rect(x - 2, y - 5, 6, 6, S.light);
    g.rect(x - 1, y + 1, 4, 1, S.light);
    g.set(x, y + 2, S.light);
    g.set(x + 1, y + 2, S.light);
    for (const [px, py] of [
      [x - 2, y - 5],
      [x + 3, y - 5],
    ] as const)
      g.set(px, py, S.metal);
    g.line([x - 2, y - 4], [x - 2, y], S.metalDark);
    g.set(x + 0.5, y - 2.5, S.gold);
  } else if (item === 'grimoire') {
    if (pose === 'cast') {
      g.rect(x - 2, y + 2, 5, 2, S.white);
      g.set(x, y + 2, S.leatherDark);
      for (const [px, py] of [
        [x - 1, y],
        [x + 2, y - 1],
        [x, y - 2],
      ] as const)
        g.set(px, py, S.glow);
    } else {
      g.rect(x - 1, y - 1, 3, 4, S.dark);
      g.line([x - 1, y - 1], [x - 1, y + 2], S.gold);
    }
  }
}

/** A second main weapon rides diagonally on the back. */
function slung(g: Grid, item: Equipment, bob: number) {
  g.line(
    [9, 22 + bob],
    [18, 9 + bob],
    item === 'bow' || item === 'staff' || item === 'spear' ? S.wood : S.metalDark,
  );
}

function humanoid(g: Grid, look: SpriteLook, pose: SpritePose, winged: boolean) {
  if (pose === 'down') return lying(g, look);
  const rig = RIGS[pose];
  const { bob, lean } = rig;
  const main = look.equipment.filter((e) => MAIN.includes(e));
  if (main[1]) slung(g, main[1], bob);
  if (winged) wings(g, pose, bob);
  // Cape behind the body.
  const flutter = pose === 'fly-a' || pose === 'dodge' || pose === 'step-a' ? 2 : 0;
  g.rect(10 - flutter + lean, 12 + bob, 3 + flutter, 10 - flutter, S.dark);
  g.limb([10 + lean, 12 + bob], rig.backHand, S.dark, S.dark);
  g.rect(rig.backHand[0], rig.backHand[1], 2, 1, S.skinDark);
  // Legs and boots.
  for (const [index, foot] of [rig.backFoot, rig.frontFoot].entries()) {
    const hip: Point = [(index ? 16 : 13) + lean, 19 + bob];
    const knee = rig.knees?.[1 - index];
    if (knee) {
      g.limb(hip, knee, S.cloth, S.cloth);
      g.limb(knee, foot, S.cloth, S.cloth);
    } else g.limb(hip, foot, S.cloth, S.cloth);
    g.rect(foot[0], foot[1] + 1, 2, 2, S.leatherDark);
    g.set(foot[0] + 2, foot[1] + 2, S.leatherDark);
  }
  // Torso, belt and collar.
  g.rect(12 + lean, 12 + bob, 8, 7, S.base);
  g.line([12 + lean, 12 + bob], [12 + lean, 17 + bob], S.light);
  g.line([19 + lean, 12 + bob], [19 + lean, 18 + bob], S.dark);
  g.line([12 + lean, 18 + bob], [19 + lean, 18 + bob], S.dark);
  g.line([12 + lean, 17 + bob], [19 + lean, 17 + bob], S.leather);
  g.set(16 + lean, 17 + bob, S.gold);
  g.set(15 + lean, 12 + bob, S.skin);
  g.set(16 + lean, 12 + bob, S.skin);
  // Head: hood/hair, face turned toward the facing side, two eyes.
  const hx = 12 + Math.max(0, lean),
    hy = 5 + bob;
  g.rect(hx + 1, hy, 6, 1, S.hair);
  g.rect(hx, hy + 1, 8, 6, S.hair);
  g.rect(hx + 2, hy + 2, 6, 5, S.skin);
  g.line([hx + 7, hy + 2], [hx + 7, hy + 6], S.skinDark);
  g.line([hx + 2, hy + 6], [hx + 6, hy + 6], S.skinDark);
  g.set(hx + 2, hy + 2, S.hair);
  g.set(hx + 4, hy + 3, S.outline);
  g.set(hx + 6, hy + 3, S.outline);
  // Front arm and main weapon.
  const off = look.equipment.find((e) => e === 'shield' || e === 'grimoire');
  if (off) offHand(g, off, rig.backHand, pose);
  if (main[0]) weapon(g, main[0], rig.frontHand, rig.weapon, pose);
  g.limb([19 + lean, 12 + bob], rig.frontHand, S.base, S.dark);
  g.rect(rig.frontHand[0], rig.frontHand[1], 2, 1, S.skin);
  if (pose === 'cast')
    for (const [x, y] of [
      [rig.frontHand[0] + 2, rig.frontHand[1] - 1],
      [rig.backHand[0] - 1, rig.backHand[1] - 1],
    ] as const)
      g.set(x, y, S.glow);
}

function wings(g: Grid, pose: SpritePose, bob: number) {
  const tip: Point =
    pose === 'fly-a' || pose === 'jump'
      ? [2, 2 + bob]
      : pose === 'fly-b'
        ? [1, 19 + bob]
        : [6, 9 + bob];
  const root: Point = [11, 13 + bob],
    low: Point = [8, 22 + bob];
  for (let t = 0; t <= 1; t += 0.05) {
    const a: Point = [root[0] + (tip[0] - root[0]) * t, root[1] + (tip[1] - root[1]) * t];
    const b: Point = [low[0] + (tip[0] - low[0]) * t, low[1] + (tip[1] - low[1]) * t];
    g.line(a, b, S.dark);
  }
  g.line(root, tip, S.light);
  g.line([10, 16 + bob], tip, S.base);
}

function lying(g: Grid, look: SpriteLook) {
  g.rect(12, 28, 9, 1, S.dark);
  g.rect(3, 24, 2, 4, S.leatherDark);
  g.rect(5, 24, 8, 4, S.cloth);
  g.rect(13, 23, 8, 5, S.base);
  g.line([13, 27], [20, 27], S.dark);
  g.line([13, 22], [19, 22], S.dark);
  g.rect(21, 22, 7, 6, S.hair);
  g.rect(21, 23, 5, 5, S.skin);
  g.line([22, 25], [23, 26], S.outline);
  g.line([23, 25], [22, 26], S.outline);
  const main = look.equipment.find((e) => MAIN.includes(e));
  if (main) weapon(g, main, [14, 29], 0, 'down');
}

function beast(g: Grid, look: SpriteLook, pose: SpritePose) {
  const down = pose === 'down';
  const lunge = pose === 'attack' ? 2 : pose === 'recover' ? 1 : 0;
  const lift = pose === 'jump' ? -3 : pose === 'fly-a' ? -2 : pose === 'fly-b' ? -1 : 0;
  const cx = 14,
    cy = (down ? 25 : pose === 'crouch' ? 21 : 19) + lift;
  // Tail, legs, body, head.
  g.line([cx - 7, cy - 1], [cx - 10, cy - 6], S.dark);
  if (!down) {
    const stride = pose === 'step-a' ? 1 : pose === 'step-b' ? -1 : 0;
    const floor = pose === 'jump' ? cy + 7 : 28;
    for (const [x, s] of [
      [cx - 5, stride],
      [cx - 2, -stride],
      [cx + 3, -stride],
      [cx + 6, stride],
    ] as const)
      g.limb([x, cy + 3], [x + s + (pose === 'attack' && x > cx ? 1 : 0), floor], S.dark, S.dark);
  }
  g.ellipse(cx, cy, 7.5, down ? 3 : 4.5, (_, y) =>
    y < cy - 2 ? S.dark : y > cy + 2 ? S.light : S.base,
  );
  const hx = cx + 8 + lunge,
    hy = cy - (down ? 1 : 4);
  g.ellipse(hx, hy, 3.5, 3, () => S.base);
  g.rect(hx + 2, hy, 4, 2, S.light);
  g.set(hx + 5, hy, S.outline);
  g.rect(hx - 2, hy - 5, 2, 3, S.dark);
  if (down) g.line([hx + 1, hy - 1], [hx + 2, hy - 1], S.outline);
  else g.set(hx + 1, hy - 1, S.white);
  if (pose === 'attack') {
    g.line([hx + 2, hy + 2], [hx + 5, hy + 2], S.outline);
    g.set(hx + 3, hy + 2, S.white);
  }
  // Equipment reads as natural armament.
  for (const item of look.equipment) {
    if (item === 'blade' || item === 'axe') g.line([hx - 1, hy - 3], [hx + 3, hy - 6], S.metal);
    else if (item === 'spear') for (let x = cx - 5; x <= cx + 3; x += 2) g.set(x, cy - 5, S.metal);
    else if (item === 'staff') g.ellipse(hx - 1, hy - 5, 1.2, 1.2, () => S.glow);
    else if (item === 'shield') g.rect(cx - 3, cy - 2, 5, 4, S.metalDark);
    else if (item === 'grimoire') g.rect(cx - 1, cy - 11, 3, 3, S.gold);
    else g.line([cx - 4, cy - 4], [cx - 1, cy - 7], S.wood);
  }
}

function construct(g: Grid, look: SpriteLook, pose: SpritePose) {
  if (pose === 'down') {
    g.rect(4, 22, 22, 7, S.base);
    g.line([4, 22], [25, 22], S.light);
    g.rect(25, 23, 4, 5, S.dark);
    g.set(8, 25, S.glow);
    return;
  }
  const rig = RIGS[pose];
  const bob = Math.max(-2, Math.min(3, rig.bob)),
    lean = rig.lean;
  for (const [x, foot] of [
    [12, rig.backFoot],
    [18, rig.frontFoot],
  ] as const)
    g.limb([x + lean, 24 + bob], [foot[0] + 1, 28], S.dark, S.dark);
  g.rect(11, 28, 4, 2, S.dark);
  g.rect(17, 28, 4, 2, S.dark);
  g.limb([9 + lean, 12 + bob], [rig.backHand[0] - 1, rig.backHand[1] + 2], S.dark, S.dark);
  g.rect(rig.backHand[0] - 2, rig.backHand[1] + 2, 3, 3, S.dark);
  g.rect(10 + lean, 11 + bob, 12, 14, S.base);
  g.line([10 + lean, 11 + bob], [21 + lean, 11 + bob], S.light);
  g.line([21 + lean, 12 + bob], [21 + lean, 24 + bob], S.dark);
  g.line([13 + lean, 14 + bob], [15 + lean, 19 + bob], S.dark);
  g.rect(15 + lean, 16 + bob, 2, 2, S.glow);
  g.rect(13 + lean, 6 + bob, 6, 5, S.base);
  g.line([15 + lean, 8 + bob], [17 + lean, 8 + bob], S.glow);
  for (const [x, y] of [
    [11, 12],
    [20, 12],
    [11, 23],
    [20, 23],
  ] as const)
    g.set(x + lean, y + bob, S.metal);
  const main = look.equipment.find((e) => MAIN.includes(e));
  if (main) weapon(g, main, [rig.frontHand[0] + 1, rig.frontHand[1] + 1], rig.weapon, pose);
  const off = look.equipment.find((e) => e === 'shield' || e === 'grimoire');
  if (off) offHand(g, off, [rig.backHand[0] - 1, rig.backHand[1] + 1], pose);
  g.limb([21 + lean, 12 + bob], [rig.frontHand[0] + 1, rig.frontHand[1] + 1], S.base, S.dark);
  g.rect(rig.frontHand[0], rig.frontHand[1] + 1, 3, 3, S.base);
}

function amorphous(g: Grid, look: SpriteLook, pose: SpritePose) {
  const shape: Record<SpritePose, readonly [number, number, number, number]> = {
    idle: [16, 23, 9, 6.5],
    'step-a': [16, 24, 10, 5.5],
    'step-b': [16, 22.5, 8, 7],
    attack: [18, 23.5, 11, 5.5],
    recover: [17, 23.5, 10, 6],
    cast: [16, 21.5, 7.5, 8],
    jump: [16, 19, 7.5, 7],
    crouch: [16, 25, 10.5, 4.5],
    down: [16, 27, 11, 3],
    dodge: [13, 23.5, 8.5, 6],
    'fly-a': [16, 18, 8, 6.5],
    'fly-b': [16, 19, 8.5, 6],
  };
  const [cx, cy, rx, ry] = shape[pose];
  g.ellipse(cx, cy, rx, ry, (x, y) =>
    y > cy + ry - 2.5
      ? S.dark
      : (x - cx) ** 2 / rx ** 2 + (y - cy + 1) ** 2 / ry ** 2 < 0.35
        ? S.light
        : S.base,
  );
  if (pose === 'attack') g.rect(cx + rx - 1, cy - 1, 4, 3, S.base);
  const main = look.equipment.find((e) => MAIN.includes(e));
  if (main) g.line([cx - 3, cy + 2], [cx + 1, cy - 1], main === 'staff' ? S.glow : S.metalDark);
  g.set(cx - rx / 2, cy - ry / 2, S.white);
  g.set(cx - rx / 2 + 1, cy - ry / 2, S.white);
  if (pose === 'down') g.line([cx + 1, cy - 1], [cx + 4, cy - 1], S.outline);
  else
    for (const x of [cx + 2, cx + 5]) {
      g.set(x, cy - 2, S.outline);
      g.set(x, cy - 1, S.outline);
    }
}

function palette(look: SpriteLook, flash: boolean): Rgb[] {
  const base = rgb(look.colour),
    white = rgb('#fffaf0'),
    ink = rgb('#1a1320');
  const colours: Rgb[] = [
    [0, 0, 0],
    ink,
    base,
    mix(base, white, 0.32),
    mix(base, ink, 0.42),
    rgb('#f1c7a0'),
    rgb('#c98f6b'),
    rgb('#3a2922'),
    rgb('#7b4f2d'),
    rgb('#4b2f1b'),
    rgb('#39364a'),
    rgb('#dfe5ee'),
    rgb('#8995a6'),
    rgb('#eab54a'),
    rgb('#8f6136'),
    rgb(look.glow),
    white,
  ];
  return flash ? colours.map((c, slot) => (slot === S.outline ? c : white)) : colours;
}

/**
 * One pixel-art frame facing +x (renderers mirror it). The same look and pose always produce
 * the same pixels; nothing here reads combat state.
 */
export function spriteImage(look: SpriteLook, pose: SpritePose, flash = false): PixelImage {
  const g = new Grid();
  if (look.silhouette === 'beast') beast(g, look, pose);
  else if (look.silhouette === 'construct') construct(g, look, pose);
  else if (look.silhouette === 'amorphous') amorphous(g, look, pose);
  else humanoid(g, look, pose, look.silhouette === 'winged');
  // Classic one-pixel dark outline around every filled pixel.
  const filled = g.cells.slice();
  for (let y = 0; y < SPRITE_SIZE; y++)
    for (let x = 0; x < SPRITE_SIZE; x++)
      if (
        !filled[y * SPRITE_SIZE + x] &&
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => {
          const nx = x + dx!,
            ny = y + dy!;
          return (
            nx >= 0 &&
            ny >= 0 &&
            nx < SPRITE_SIZE &&
            ny < SPRITE_SIZE &&
            filled[ny * SPRITE_SIZE + nx]
          );
        })
      )
        g.set(x, y, S.outline);
  const colours = palette(look, flash),
    image = blank(SPRITE_SIZE, SPRITE_SIZE);
  for (let y = 0; y < SPRITE_SIZE; y++)
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const slot = g.get(x, y);
      if (slot) plot(image, x, y, colours[slot]!, 255, false);
    }
  return image;
}

export type PoseState = {
  defeated: boolean;
  posture: 'standing' | 'crouching' | 'prone';
  grounded: boolean;
  locomotion: {
    mode: 'idle' | 'walk' | 'run' | 'slow' | 'flight';
    jumping: boolean;
    dodging: boolean;
  } | null;
  phase: 'cast' | 'active' | 'recovery' | null;
};
/**
 * Material alpha for a sprite. Texels are fully opaque or fully clear, so the cutoff scales with
 * the opacity: a translucent phased figure keeps its whole silhouette. Phased bodies are drawn
 * through the terrain they pass through instead of disappearing inside it.
 */
export function spriteFade(phasing: { pending: boolean } | null) {
  const opacity = phasing ? (phasing.pending ? 0.3 : 0.45) : 1;
  return { opacity, alphaTest: opacity / 2, throughTerrain: phasing !== null };
}

const GAIT_MS = { walk: 180, run: 110, slow: 260, flight: 150 } as const;

/** Frame choice from recorded state; `milliseconds` is the displayed step time, not a clock. */
export function spritePose(state: PoseState, milliseconds: number): SpritePose {
  const cycle = (period: number) => Math.floor(milliseconds / period) % 2 === 0;
  const mode = state.locomotion?.mode ?? 'idle';
  if (state.defeated || state.posture === 'prone') return 'down';
  if (state.phase === 'cast') return 'cast';
  if (state.phase === 'active') return 'attack';
  if (state.phase === 'recovery') return 'recover';
  if (state.locomotion?.dodging) return 'dodge';
  if (state.posture === 'crouching') return 'crouch';
  if (mode === 'flight') return cycle(GAIT_MS.flight) ? 'fly-a' : 'fly-b';
  if (!state.grounded || state.locomotion?.jumping) return 'jump';
  if (mode !== 'idle') return cycle(GAIT_MS[mode]) ? 'step-a' : 'step-b';
  return 'idle';
}
