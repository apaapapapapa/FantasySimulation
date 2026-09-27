import { blank, mix, plot, rgb, shade, type PixelImage, type Rgb } from './pixel-art.ts';

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

export const SPRITE_SIZE = 48;
/** Pixel row of the soles; renderers anchor it to the bottom of the recorded body. */
export const SPRITE_FEET = 43;
const FIGURE_TOP = 11;
/** Standing figure height in pixels; renderers scale it to the saved body height. */
export const SPRITE_FIGURE = SPRITE_FEET - FIGURE_TOP + 1;
/**
 * Whole drawing-buffer pixels per texel for a figure of this saved height, given how many pixels
 * a metre covers at the framed distance. A whole number keeps every dot the same size; the drawn
 * figure stays within about a third of its true height once it is two or more pixels per texel.
 */
export const spritePixelScale = (heightMetres: number, pixelsPerMetre: number) =>
  Math.max(1, Math.round((heightMetres * pixelsPerMetre) / SPRITE_FIGURE));

/**
 * Palette keys used by the templates and the drawing helpers. Ramps run light → dark:
 * main colour 1234, trousers 567, skin sSt, hair hHj, metal mMnN, leather lLk, gold gGy,
 * wood dDb, fur fFr, accent xXz (from the glow tint), plus white, eye, glow and glow core.
 */
const KEYS = '.o1234567sSthHjmMnNlLkgGydDbfFrwe*+xXz';
type Ramp = string;
type P = readonly [number, number];
const N = SPRITE_SIZE;
const LIGHT: P = [-0.6, -0.8];

class Grid {
  readonly cells = new Uint8Array(N * N);
  set(x: number, y: number, key: string) {
    const px = Math.floor(x),
      py = Math.floor(y);
    if (px >= 0 && py >= 0 && px < N && py < N) this.cells[py * N + px] = KEYS.indexOf(key);
  }
  filled(x: number, y: number) {
    return x >= 0 && y >= 0 && x < N && y < N && this.cells[y * N + x]! > 0;
  }
  stamp(rows: readonly string[], x: number, y: number) {
    rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++)
        if (row[dx] !== '.') this.set(x + dx, y + dy, row[dx]!);
    });
  }
  /** Paints every pixel whose centre `paint` assigns a key, within a bounding box. */
  area(box: readonly [number, number, number, number], paint: (x: number, y: number) => string) {
    const [left, top, right, bottom] = box;
    for (let y = Math.max(0, Math.floor(top)); y <= Math.min(N - 1, Math.floor(bottom)); y++)
      for (let x = Math.max(0, Math.floor(left)); x <= Math.min(N - 1, Math.floor(right)); x++) {
        const key = paint(x + 0.5, y + 0.5);
        if (key && key !== '.') this.set(x, y, key);
      }
  }
  /** Composites a separately drawn part and outlines it where it covers earlier pixels. */
  over(part: Grid) {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++)
        if (
          !part.filled(x, y) &&
          this.filled(x, y) &&
          NEIGHBOURS.some(([dx, dy]) => part.filled(x + dx, y + dy))
        )
          this.cells[y * N + x] = 1;
    part.cells.forEach((cell, i) => {
      if (cell) this.cells[i] = cell;
    });
  }
}
const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const part = (draw: (g: Grid) => void) => {
  const g = new Grid();
  draw(g);
  return g;
};
const shift = ([x, y]: P, [dx, dy]: P): P => [x + dx, y + dy];
const FAR: Record<string, Ramp> = {
  '123': '234',
  lLk: 'Lkk',
  mMn: 'MnN',
  sSt: 'Stt',
  fFr: 'Frr',
};

/** A limb lit from the upper left: capsule from a to b with radius r, shaded by its normal. */
function limb(g: Grid, a: P, b: P, r: number, ramp: Ramp) {
  const [abx, aby] = [b[0] - a[0], b[1] - a[1]];
  const length = abx * abx + aby * aby || 1;
  g.area(
    [
      Math.min(a[0], b[0]) - r - 1,
      Math.min(a[1], b[1]) - r - 1,
      Math.max(a[0], b[0]) + r + 1,
      Math.max(a[1], b[1]) + r + 1,
    ],
    (x, y) => {
      const t = Math.min(1, Math.max(0, ((x - a[0]) * abx + (y - a[1]) * aby) / length));
      const dx = x - a[0] - abx * t,
        dy = y - a[1] - aby * t,
        d = Math.hypot(dx, dy);
      if (d > r) return '.';
      const lit = d ? (dx * LIGHT[0] + dy * LIGHT[1]) / r : 0;
      return lit > 0.4 ? ramp[0]! : lit < -0.25 ? ramp[2]! : ramp[1]!;
    },
  );
}
const disc = (g: Grid, c: P, r: number, ramp: Ramp) => limb(g, c, c, r, ramp);

/**
 * Something held along `angle` (degrees, 0 = forward, 90 = up) from a hand. `paint` receives
 * u along the direction and v across it, positive toward the lit upper side.
 */
function held(
  g: Grid,
  hand: P,
  angle: number,
  reach: number,
  paint: (u: number, v: number) => string,
) {
  const a = (angle * Math.PI) / 180,
    dir: P = [Math.cos(a), -Math.sin(a)],
    across: P = [dir[1], -dir[0]];
  g.area([hand[0] - reach, hand[1] - reach, hand[0] + reach, hand[1] + reach], (x, y) => {
    const dx = x - hand[0],
      dy = y - hand[1];
    return paint(dx * dir[0] + dy * dir[1], dx * across[0] + dy * across[1]);
  });
}
const edge = (v: number, width: number, ramp: Ramp) =>
  v > width * 0.35 ? ramp[0]! : v < -width * 0.35 ? ramp[2]! : ramp[1]!;

const MAIN: readonly Equipment[] = ['blade', 'axe', 'spear', 'staff', 'bow'];

function weapon(g: Grid, item: Equipment, hand: P, angle: number, drawn = false) {
  if (item === 'blade')
    held(g, hand, angle, 16, (u, v) => {
      if (u >= -4 && u < -2.6 && Math.abs(v) <= 1.1) return 'G';
      if (u >= -2.6 && u < -0.6 && Math.abs(v) < 0.8) return 'k';
      if (u >= -0.6 && u < 0.9 && Math.abs(v) <= 3)
        return Math.abs(v) > 2.2 ? 'y' : v > 0 ? 'g' : 'G';
      const half = u > 11 ? 1.3 * Math.max(0, (13.5 - u) / 2.5) : 1.3;
      if (u >= 0.9 && u < 13.5 && Math.abs(v) <= half)
        return u > 8 && u < 9.6 && v > 0 ? 'w' : edge(v, 1.3, 'mMn');
      return '.';
    });
  else if (item === 'axe')
    held(g, hand, angle, 16, (u, v) => {
      if (u >= -3 && u < 12 && Math.abs(v) <= 0.7) return v > 0 ? 'd' : 'D';
      const blade = u >= 7.5 && u <= 13 && v > 0 && v <= 5 - Math.abs(u - 10.2) * 0.9;
      if (blade) return v > 3.2 ? 'm' : u > 11 ? 'n' : 'M';
      if (u >= 8.5 && u <= 11 && v < 0 && v >= -2) return 'N';
      return '.';
    });
  else if (item === 'spear')
    held(g, hand, angle, 20, (u, v) => {
      if (u >= -10 && u < 12 && Math.abs(v) <= 0.6) return v > 0 ? 'd' : 'D';
      if (u >= 11 && u < 12.5 && Math.abs(v) <= 1.4) return 'G';
      const half = 1.9 * (1 - Math.abs(u - 14.5) / 3.5);
      if (u >= 12.5 && u <= 18 && Math.abs(v) <= half) return edge(v, half, 'mMn');
      return '.';
    });
  else if (item === 'staff')
    held(g, hand, angle, 18, (u, v) => {
      const orb = Math.hypot(u - 13.5, v);
      if (orb <= 1.2) return '+';
      if (orb <= 2.4) return '*';
      if (u >= 10 && u < 12 && Math.abs(v) >= 1.2 && Math.abs(v) <= 2.6) return 'G';
      if (u >= -9 && u < 11.5 && Math.abs(v) <= 0.7) return v > 0 ? 'd' : 'b';
      return '.';
    });
  else if (item === 'bow') {
    const nock = drawn ? -3 : 0;
    held(g, hand, angle, 12, (u, v) => {
      const bend = 2.6 - (v * v) / 18;
      if (Math.abs(v) <= 7 && Math.abs(u - bend) <= 0.75) return Math.abs(v) > 5.5 ? 'b' : 'D';
      // String from both tips to the nock point.
      const tipU = 2.6 - 49 / 18;
      const along = nock + ((tipU - nock) * Math.abs(v)) / 7;
      if (Math.abs(v) <= 7 && Math.abs(u - along) <= 0.4) return 'w';
      if (drawn && Math.abs(v) <= 0.5 && u >= nock && u <= 9) return u > 7.5 ? 'M' : 'd';
      return '.';
    });
  }
}

const SHIELD = [
  '.nMMMMn.',
  'nM1222Mn',
  'M122g22M',
  'M12ggg2M',
  'M122g23M',
  'nM2223Mn',
  '.nM23Mn.',
  '..nMMn..',
];
const BOOK = ['yGGGGy', 'G4333G', 'G4323G', 'G4333G', 'yGGGGy'];
const OPEN_BOOK = ['.www.www.', 'wwwwwwwww', 'kwwwkwwwk', '.kkk.kkk.'];

function offHand(g: Grid, item: Equipment, hand: P, casting: boolean) {
  const [x, y] = [Math.round(hand[0]), Math.round(hand[1])];
  if (item === 'shield') g.stamp(SHIELD, x - 4, y - 4);
  else if (item === 'grimoire')
    if (casting) {
      g.stamp(OPEN_BOOK, x - 4, y - 1);
      for (const [dx, dy] of [
        [-2, -3],
        [1, -5],
        [3, -3],
      ] as const)
        g.set(x + dx, y + dy, '*');
    } else g.stamp(BOOK, x - 3, y - 2);
}

type Kit = {
  head: keyof typeof HEADS;
  torso: keyof typeof TORSOS;
  back: 'scarf' | 'cape' | 'cloak' | 'robe' | null;
  /** Upper arm, forearm and hand ramps (front arm; the far arm uses the darker neighbours). */
  arms: readonly [Ramp, Ramp, Ramp];
  shoulder: Ramp | null;
};
/** Outfit from the recorded equipment only; nothing is inferred from abilities or names. */
function kit(equipment: readonly Equipment[]): Kit {
  const has = (item: Equipment) => equipment.includes(item);
  const main = equipment.find((e) => MAIN.includes(e));
  if (has('staff') || has('grimoire'))
    return {
      head: 'hat',
      torso: 'robe',
      back: 'robe',
      arms: ['123', '123', 'sSt'],
      shoulder: null,
    };
  if (has('shield'))
    return {
      head: 'helm',
      torso: 'armor',
      back: 'cape',
      arms: ['mMn', 'mMn', 'mMn'],
      shoulder: 'mMn',
    };
  if (main === 'bow')
    return {
      head: 'hood',
      torso: 'leather',
      back: 'cloak',
      arms: ['123', 'lLk', 'sSt'],
      shoulder: 'lLk',
    };
  if (main === 'axe')
    return {
      head: 'horned',
      torso: 'armor',
      back: 'cape',
      arms: ['sSt', 'lLk', 'sSt'],
      shoulder: 'fFr',
    };
  if (main === 'spear')
    return {
      head: 'winged',
      torso: 'armor',
      back: 'cape',
      arms: ['123', 'mMn', 'lLk'],
      shoulder: 'mMn',
    };
  if (main === 'blade')
    return {
      head: 'band',
      torso: 'tunic',
      back: 'cape',
      arms: ['123', 'lLk', 'sSt'],
      shoulder: 'mMn',
    };
  return {
    head: 'spiky',
    torso: 'strap',
    back: 'scarf',
    arms: ['123', 'lLk', 'sSt'],
    shoulder: null,
  };
}

/** Torso templates (11×9) drawn at the shoulders; light comes from the upper left. */
const TORSOS = {
  strap: [
    '..1122223..',
    '.112222Lk3.',
    '.12222Lk33.',
    '.1222Lk233.',
    '.122Lk2333.',
    '.12Lk23334.',
    '.lLLLGLLkk.',
    '.122222334.',
    '..2233344..',
  ],
  tunic: [
    '..1122223..',
    '.112222223.',
    '.122222233.',
    '.122222233.',
    '.122222333.',
    '.122223334.',
    '.lLLLGLLkk.',
    '.122222334.',
    '..2233344..',
  ],
  armor: [
    '..mmMMMMn..',
    '.mmMMMMMMn.',
    '.mMMMmMMnn.',
    '.mMMmMMMnn.',
    '.nMMMMMnnN.',
    '.2nnnnnnN3.',
    '.lLLLGLLkk.',
    '.122222334.',
    '..2233344..',
  ],
  leather: [
    '..1122223..',
    '.1lLL2LLk3.',
    '.1lLL2Lkk3.',
    '.1lLL2Lkk3.',
    '.2lLL2kkk3.',
    '.2kkk3kkk4.',
    '.lLLLGLLkk.',
    '.122222334.',
    '..2233344..',
  ],
  robe: [
    '..11G2223..',
    '.1122G2223.',
    '.12222G233.',
    '.122222G33.',
    '.1222222G3.',
    '.12222233G.',
    '.yGGGGGGGy.',
    '.122222334.',
    '.122222334.',
  ],
};

/** Heads (13 wide) facing right; `x`/`y` place templates that reach past the skull. */
const FACE = [
  'jjjtSjjSSjjSs',
  '.jjtSSeSSSeSs',
  '.jjtSSeSSSeSt',
  '..jtSSSSSSSS.',
  '...ttSSSSSt..',
  '....tttttt...',
];
const HEADS = {
  spiky: {
    x: -2,
    y: -1,
    rows: [
      '......H...H....',
      '...H..HH.HH.H..',
      '..jHHHHHHHHHH..',
      'jjjHHHhhhhHHHH.',
      '.jjjHhhhhhhHHHH',
      'jjjjHHhhHHHHHHH',
      '.jjjHHHHHHHHHHH',
      'jjjjjHHtHHHtHHH',
      ...FACE.map((row) => `..${row}`),
    ],
  },
  band: {
    x: -4,
    y: 0,
    rows: [
      '.......H..H..H...',
      '......HHH.HH.HH..',
      '.....jHHHHHhHHHH.',
      '....jjHHhhhhhhHHH',
      '....jjHhhhhHHHHHH',
      '..3.jj12222222222',
      '.334jj33333333333',
      ...FACE.map((row, i) => (['3344', '344.', '44..'][i] ?? '....') + row),
    ],
  },
  hood: {
    x: -2,
    y: -1,
    rows: [
      '......2222......',
      '....22111122....',
      '...2111122222...',
      '..211122222222..',
      '.21112222222223.',
      '321122222222233.',
      '3212222222223333',
      '321222333tttt34.',
      '32223tjtSSSSSSs.',
      '32233tjSSeSSSeSs',
      '4323.tjSSeSSSeSt',
      '4333.4jtSSSSSSS.',
      '43334.4ttSSSSSt.',
      '.4433344tttttt..',
      '..44333344......',
    ],
  },
  hat: {
    x: -3,
    y: -9,
    rows: [
      '..4................',
      '..34...............',
      '...33..............',
      '...332.............',
      '....3322...........',
      '....33222..........',
      '....332222.........',
      '...3332221.........',
      '...33322211........',
      '..yyGGGGGGGGgy.....',
      '..333222222221.....',
      '.33332222222221....',
      '433322222222222211.',
      '.4433333333333333..',
      '...jjjjtSSSSSSSs...',
      '....jjjtSSeSSSeSs..',
      '....jjjtSSeSSSeSt..',
      '.....jjtSSSSSSSS...',
      '......jttSSSSSt....',
      '.......tttttt......',
    ],
  },
  helm: {
    x: -3,
    y: -1,
    rows: [
      '......3322.......',
      '....33221122.....',
      '...4.3321MMMMn...',
      '.43..3mmmmMMMMn..',
      '433..mmMMMMMMMMn.',
      '43...mMMMMMMMMMn.',
      '3....mMMMMMMMMMMn',
      '.....mMMNNNNNN*Nn',
      '.....mMMMMMMMMMMn',
      '.....nMMMMnMMMnn.',
      '.....nnMMMnnMMn..',
      '......nnnMnnnn...',
      '.......nNNNNN....',
      '........ttttt....',
    ],
  },
  horned: {
    x: -3,
    y: -3,
    rows: [
      'ff..............ff.',
      'fr..............rf.',
      '.fr...........frf..',
      '.frr..MMMMMn.frr...',
      '..frrmmMMMMMnrr....',
      '...frMMMMMMMMn.....',
      '....mMMgMMgMMMn....',
      '....nnnnnnnnnnn....',
      '...jjjjSHHSHSHH....',
      ...FACE.map((row) => `...${row}...`),
    ],
  },
  winged: {
    x: -3,
    y: -1,
    rows: [
      '.w................',
      'www....MMMMn......',
      '.www.mmMMMMMn.....',
      '..wwwmMMMMMMMn....',
      '...wwMMMgMMMMMn...',
      '....wnnnnnnnnnnN..',
      '....jjjjjHHSMSHH..',
      ...FACE.map((row) => `...${row}..`),
    ],
  },
};

/** Standing anchors; every pose moves them. */
const TORSO_AT: P = [18, 24];
const HEAD_AT: P = [17, 11];
const HIPS: readonly [P, P] = [
  [21.5, 33.5],
  [25.5, 33.5],
];
const SHOULDERS: readonly [P, P] = [
  [19.5, 25.5],
  [27.5, 25.5],
];
type Rig = {
  body: P;
  /** Back leg then front leg: knee and ankle. */
  legs: readonly [P, P, P, P];
  /** Back arm then front arm: elbow and hand. */
  arms: readonly [P, P, P, P];
  weapon: number;
  cape: number;
};
const RIGS: Record<Exclude<SpritePose, 'down'>, Rig> = {
  idle: {
    body: [0, 0],
    legs: [
      [21, 37.5],
      [20.5, 40.5],
      [26, 37.5],
      [26.5, 40.5],
    ],
    arms: [
      [18.5, 29],
      [19, 32],
      [28.5, 29],
      [29, 32],
    ],
    weapon: -45,
    cape: 0,
  },
  'step-a': {
    body: [0, 1],
    legs: [
      [20, 38],
      [18.5, 40.5],
      [27.5, 37.5],
      [28.5, 40.5],
    ],
    arms: [
      [20.5, 30],
      [22.5, 32.5],
      [27, 30],
      [25.5, 32.5],
    ],
    weapon: -45,
    cape: 2,
  },
  'step-b': {
    body: [0, 0],
    legs: [
      [22.5, 37.5],
      [22, 40.5],
      [25, 37.5],
      [24.5, 40.5],
    ],
    arms: [
      [19, 29],
      [19.5, 32],
      [28, 29],
      [28.5, 32],
    ],
    weapon: -45,
    cape: 1,
  },
  attack: {
    body: [2, 1],
    legs: [
      [20, 38],
      [17.5, 40.5],
      [29.5, 37],
      [30.5, 40.5],
    ],
    arms: [
      [19.5, 29.5],
      [18, 31.5],
      [32, 26.5],
      [35, 26.5],
    ],
    weapon: 0,
    cape: 3,
  },
  recover: {
    body: [1, 1],
    legs: [
      [20.5, 38],
      [18.5, 40.5],
      [28.5, 37.5],
      [29.5, 40.5],
    ],
    arms: [
      [19.5, 29.5],
      [19, 32],
      [30.5, 29],
      [32.5, 31.5],
    ],
    weapon: -45,
    cape: 1,
  },
  cast: {
    body: [0, 0],
    legs: [
      [20.5, 37.5],
      [19.5, 40.5],
      [26.5, 37.5],
      [27.5, 40.5],
    ],
    arms: [
      [19.5, 23.5],
      [21, 20.5],
      [30, 23.5],
      [31, 20.5],
    ],
    weapon: 90,
    cape: 1,
  },
  jump: {
    body: [0, -3],
    legs: [
      [22.5, 34],
      [20, 36.5],
      [28, 33.5],
      [27, 37],
    ],
    arms: [
      [18.5, 24],
      [17, 21.5],
      [29.5, 24],
      [31, 21.5],
    ],
    weapon: 45,
    cape: 2,
  },
  crouch: {
    body: [1, 4],
    legs: [
      [25, 39.5],
      [21.5, 40.5],
      [30, 38],
      [29.5, 40.5],
    ],
    arms: [
      [21, 31.5],
      [22.5, 34],
      [30.5, 31],
      [32.5, 33],
    ],
    weapon: 0,
    cape: 0,
  },
  dodge: {
    body: [-2, 1],
    legs: [
      [19, 38],
      [17, 40.5],
      [25, 37.5],
      [27, 40.5],
    ],
    arms: [
      [17.5, 28],
      [15.5, 29.5],
      [26, 28.5],
      [24.5, 31],
    ],
    weapon: -135,
    cape: 4,
  },
  'fly-a': {
    body: [0, -1],
    legs: [
      [21, 37],
      [20, 40],
      [25.5, 37],
      [25, 40.5],
    ],
    arms: [
      [18, 27],
      [16, 28.5],
      [29.5, 27],
      [31.5, 28.5],
    ],
    weapon: -45,
    cape: 3,
  },
  'fly-b': {
    body: [0, 0],
    legs: [
      [21.5, 37.5],
      [21, 40.5],
      [25.5, 37.5],
      [25.5, 40.5],
    ],
    arms: [
      [18.5, 28.5],
      [17.5, 31],
      [29, 28.5],
      [30, 31],
    ],
    weapon: -45,
    cape: 1,
  },
};
const BOOT = ['kLL..', 'kLLLl', 'kkkkk'];
/** Empty-handed fighters raise both fists instead of letting the arms hang. */
const GUARD: Partial<Record<SpritePose, Rig['arms']>> = {
  idle: [
    [21, 29.5],
    [24, 27.5],
    [29.5, 29],
    [31.5, 26.5],
  ],
  'step-a': [
    [21, 30.5],
    [24, 28.5],
    [29.5, 30],
    [31.5, 27.5],
  ],
  'step-b': [
    [21, 29.5],
    [24, 27.5],
    [29.5, 29],
    [31.5, 26.5],
  ],
  recover: [
    [21.5, 30.5],
    [24.5, 28.5],
    [30.5, 29.5],
    [33, 28],
  ],
};

function cape(g: Grid, body: P, swing: number, cloak: boolean) {
  const [bx, by] = body;
  const top = 24.5 + by,
    bottom = 38.5 + by - swing * 0.4;
  g.area([4, top, 26, bottom], (x, y) => {
    const t = (y - top) / (bottom - top);
    const left = 18 + bx - t * (2 + swing * 1.6),
      right = 24 + bx - t * swing * 0.6;
    if (x < left || x > right) return '.';
    if (cloak && x > right - 1 && t < 0.7) return '2';
    const fold = Math.floor(x - left + t * 2) % 3;
    return x < left + 1 ? '4' : fold === 0 ? '4' : '3';
  });
}

/** Scarf tails behind the back; the wrap itself is drawn over the collar. */
function scarf(g: Grid, body: P, swing: number) {
  const neck = shift([20.5, 25], body);
  g.over(part((p) => limb(p, neck, shift(neck, [-3 - swing * 1.4, 6 - swing * 0.9]), 1.3, 'XXz')));
  g.over(
    part((p) => limb(p, neck, shift(neck, [-5 - swing * 1.5, 3.5 - swing * 0.7]), 1.4, 'xXz')),
  );
}
const SCARF_WRAP = ['.xxXXXX..', 'xXXXXXzz.', 'XXzzz....'];

function robe(g: Grid, body: P, stride: number) {
  const [bx, by] = body;
  const top = 32 + by;
  g.area([10, top, 36, 41], (x, y) => {
    const t = (y - top) / (41 - top);
    const left = 18.5 + bx - t * (2 + stride * 0.3),
      right = 28.5 + bx + t * (2 + stride * 0.6);
    if (x < left || x > right) return '.';
    if (y > 40) return x < left + 2 ? 'y' : 'G';
    if (x > right - 1.2) return '4';
    return x < left + 1.5 ? '1' : Math.floor(x - left) % 4 === 3 ? '3' : '2';
  });
}

/** A wing arm with primaries hanging from it; the flap follows the recorded gait frame. */
function wings(g: Grid, body: P, pose: SpritePose) {
  const up = pose === 'fly-a' || pose === 'jump',
    down = pose === 'fly-b';
  const root = shift([22, 27], body);
  const wrist = shift(root, up ? [-7, -11] : down ? [-9, 2] : [-8, -6]);
  const hang = ((up ? 235 : down ? 250 : 240) * Math.PI) / 180;
  for (let feather = 0; feather < 6; feather++) {
    const t = feather / 5;
    const base: P = [root[0] + (wrist[0] - root[0]) * t, root[1] + (wrist[1] - root[1]) * t];
    const length = 4.5 + feather * 1.7,
      angle = hang - t * 0.4;
    const tip = shift(base, [Math.cos(angle) * length, -Math.sin(angle) * length]);
    g.over(part((p) => limb(p, base, tip, 1.5, 'fFr')));
  }
  g.over(part((p) => limb(p, root, wrist, 1.9, 'wfF')));
}

function humanoid(
  g: Grid,
  look: SpriteLook,
  pose: Exclude<SpritePose, 'down'>,
  winged: boolean,
  armed = true,
) {
  const rig = RIGS[pose];
  const outfit = kit(look.equipment);
  const main = armed ? look.equipment.filter((e) => MAIN.includes(e)) : [];
  const off = armed ? look.equipment.find((e) => e === 'shield' || e === 'grimoire') : undefined;
  const [upper, fore, hand] = outfit.arms;
  const body = rig.body;
  const [backShoulder, frontShoulder] = SHOULDERS.map((s) => shift(s, body)) as [P, P];
  const [backHip, frontHip] = HIPS.map((h) => shift(h, body)) as [P, P];
  const guard = main.length || off ? undefined : GUARD[pose];
  const [backElbow, backHand, frontElbow, frontHand] = guard ?? rig.arms;
  const [backKnee, backAnkle, frontKnee, frontAnkle] = rig.legs;

  // Behind the body: wings, slung weapon, cape and the far arm.
  if (winged) wings(g, body, pose);
  if (main[1]) weapon(g, main[1], shift([17, 32], body), 60);
  if (outfit.back === 'cape' || outfit.back === 'cloak')
    cape(g, body, rig.cape, outfit.back === 'cloak');
  if (outfit.back === 'scarf') scarf(g, body, rig.cape);
  const farArm = part((p) => {
    limb(p, backShoulder, backElbow, 1.6, FAR[upper]!);
    limb(p, backElbow, backHand, 1.5, FAR[fore]!);
    disc(p, backHand, 1.5, FAR[hand]!);
  });
  if (!guard) g.over(farArm);
  // Legs, boots, torso and head.
  g.over(
    part((p) => {
      for (const [hip, knee, ankle] of [
        [backHip, backKnee, backAnkle],
        [frontHip, frontKnee, frontAnkle],
      ] as const) {
        limb(p, hip, knee, 1.9, '567');
        limb(p, knee, ankle, 1.6, '567');
        p.stamp(BOOT, Math.round(ankle[0] - 1.5), Math.round(ankle[1] + 0.5));
      }
    }),
  );
  if (outfit.back === 'robe') robe(g, body, frontAnkle[0] - backAnkle[0] - 6);
  g.over(part((p) => p.stamp(TORSOS[outfit.torso], TORSO_AT[0] + body[0], TORSO_AT[1] + body[1])));
  if (outfit.back === 'scarf') g.over(part((p) => p.stamp(SCARF_WRAP, 19 + body[0], 23 + body[1])));
  const head = HEADS[outfit.head];
  g.over(
    part((p) => p.stamp(head.rows, HEAD_AT[0] + body[0] + head.x, HEAD_AT[1] + body[1] + head.y)),
  );
  // A raised guard brings the far fist in front of the chest.
  if (guard) g.over(farArm);
  // Held in front: the off-hand item, then the weapon arm.
  if (off) g.over(part((p) => offHand(p, off, backHand, pose === 'cast')));
  g.over(
    part((p) => {
      if (main[0]) weapon(p, main[0], frontHand, rig.weapon, pose === 'attack');
      limb(p, frontShoulder, frontElbow, 1.6, upper);
      limb(p, frontElbow, frontHand, 1.5, fore);
      disc(p, frontHand, 1.5, hand);
    }),
  );
  const pad = outfit.shoulder;
  if (pad)
    g.over(
      part((p) => {
        limb(p, shift(frontShoulder, [-1, 1]), shift(frontShoulder, [1, 1.5]), 1.7, pad);
      }),
    );
  if (pose === 'cast')
    for (const [x, y] of [
      [frontHand[0] + 2, frontHand[1] - 2],
      [backHand[0] - 2, backHand[1] - 2],
      [frontHand[0] - 1, frontHand[1] - 4],
    ] as const)
      g.set(x, y, '+');
}

function rotateDown(g: Grid) {
  // A defeated figure: the standing frame turned onto its back, lying on the feet line.
  const out = new Grid();
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const cell = g.cells[y * N + x]!;
      if (!cell) continue;
      const nx = N - 1 - y + 4,
        ny = x + (SPRITE_FEET - 30);
      if (nx >= 0 && ny >= 0 && nx < N && ny < N) out.cells[ny * N + nx] = cell;
    }
  return out;
}

/** A wolf-like quadruped: deep chest, bushy tail, hocked hind legs and a glowing eye. */
function beast(g: Grid, look: SpriteLook, pose: SpritePose) {
  const down = pose === 'down';
  const lunge = pose === 'attack' ? 3 : pose === 'recover' ? 1 : pose === 'dodge' ? -2 : 0;
  const lift =
    pose === 'jump'
      ? -5
      : pose === 'fly-a'
        ? -4
        : pose === 'fly-b'
          ? -3
          : pose === 'crouch'
            ? 2
            : 0;
  const cx = 21 + lunge,
    cy = (down ? 38 : 32) + lift;
  const stride = pose === 'step-a' ? 2.5 : pose === 'step-b' ? -2.5 : 0;
  const tuck = pose === 'jump' || pose === 'fly-a' || pose === 'fly-b';
  const floor = tuck ? cy + 7 : SPRITE_FEET - 0.5;
  const hx = cx + 9,
    hy = cy - (down ? 1 : 5);
  const paw = (p: Grid, at: P) =>
    p.stamp(['kkk.', 'kkkk'], Math.round(at[0] - 1.5), Math.round(at[1] - 0.5));
  // Lower legs: hind leg below its hock, then the straight fore leg.
  const legs = (near: boolean) => {
    const ramp = near ? '123' : '234',
      s = near ? stride : -stride;
    const hock: P = [cx - 8 + s * 0.5, floor - 3.5],
      back: P = [cx - 6.5 + s + (tuck ? -2 : 0), floor],
      front: P = [cx + 5 - s + (pose === 'attack' ? 3 : 0) + (tuck ? 2 : 0), floor];
    g.over(
      part((p) => {
        limb(p, [cx - 6, cy + 1], hock, 1.7, ramp);
        limb(p, hock, back, 1.1, ramp);
        paw(p, back);
      }),
    );
    g.over(
      part((p) => {
        limb(p, [cx + 5, cy + 1], front, near ? 1.4 : 1.2, ramp);
        paw(p, front);
      }),
    );
  };
  if (!down) legs(false);
  const wag = pose === 'idle' || pose === 'step-b' ? 0 : 2;
  g.over(
    part((p) => {
      // Bushy tail with a pale tip, then waist, chest, haunch and neck as one furred body.
      limb(p, [cx - 9, cy - 1], [cx - 14, cy - 5 + wag], 2.4, '234');
      limb(p, [cx - 13, cy - 4 + wag], [cx - 16, cy - 8 + wag * 1.5], 1.8, '123');
      disc(p, [cx - 16.5, cy - 8.5 + wag * 1.5], 1.2, 'fFr');
      limb(p, [cx - 7, cy], [cx - 1, cy], down ? 3 : 3.4, '123');
      disc(p, [cx - 6, cy + 0.5], down ? 3 : 3.6, '123');
      disc(p, [cx + 3, cy - 0.5], down ? 3.8 : 4.6, '123');
      limb(p, [cx + 4, cy - 1], [hx - 2, hy + 1], 2.6, '123');
      p.area([cx - 10, cy - 6, cx + 4, cy - 2], (x, y) =>
        p.filled(Math.floor(x), Math.floor(y)) && y < cy - 2.6 + Math.abs(x - cx + 2) * 0.12
          ? '3'
          : '.',
      );
      for (let i = 0; i < 3; i++)
        limb(p, [hx - 1 - i, hy + 3], [hx - 2 - i * 1.5, hy + 6], 0.9, 'fFr');
    }),
  );
  if (!down) legs(true);
  g.over(
    part((p) => {
      // Ears, skull, muzzle, nose, eye; the jaw opens on a recorded attack.
      limb(p, [hx - 1.5, hy - 2], [hx - 2.5, hy - 5.5], 1.3, '234');
      limb(p, [hx + 0.5, hy - 2], [hx + 0.5, hy - 5.5], 1.2, '123');
      disc(p, [hx, hy], 3.4, '123');
      limb(p, [hx + 1, hy + 0.5], [hx + 6, hy + 1.5], 1.7, '123');
      p.set(hx + 7, hy + 1, 'o');
      p.set(hx + 7, hy + 2, 'o');
      if (down) p.stamp(['oo'], hx, hy - 1);
      else p.stamp(['+*'], hx + 1, hy - 1);
      if (pose === 'attack') {
        p.stamp(['oooooo', 'w.w.w.'], hx + 1, hy + 3);
        limb(p, [hx + 1, hy + 4.5], [hx + 5, hy + 5.5], 1, '234');
      }
    }),
  );
  const armed = look.equipment.filter((e) => e !== 'shield');
  if (look.equipment.includes('shield'))
    g.over(part((p) => limb(p, [cx - 5, cy - 3.5], [cx + 2, cy - 4], 2.2, 'mMn')));
  if (armed.some((e) => e === 'staff' || e === 'grimoire')) g.set(hx - 3, hy - 8, '*');
  if (armed.some((e) => e === 'blade' || e === 'axe' || e === 'spear'))
    g.over(part((p) => limb(p, [hx - 1, hy + 4], [hx + 5, hy + 7], 0.8, 'mMn')));
  if (armed.includes('bow'))
    g.over(part((p) => limb(p, [cx - 5, cy - 4], [cx, cy - 7], 0.8, 'dDb')));
}

function construct(g: Grid, look: SpriteLook, pose: SpritePose) {
  const rig = RIGS[pose === 'down' ? 'idle' : pose];
  const body: P = [rig.body[0], Math.max(-2, Math.min(3, rig.body[1]))];
  const [bx, by] = body;
  for (const [x, ankle] of [
    [20, rig.legs[1]],
    [26, rig.legs[3]],
  ] as const)
    g.over(
      part((p) => {
        limb(p, [x + bx, 34 + by], [ankle[0], 40], 2.2, 'MnN');
        p.stamp(['nMMMn', 'NNNNN'], Math.round(ankle[0] - 2), 42);
      }),
    );
  g.over(
    part((p) => {
      limb(p, [16 + bx, 24 + by], shift(rig.arms[1], [-2, 1]), 2.3, 'MnN');
      disc(p, shift(rig.arms[1], [-2, 2]), 2.6, 'MnN');
    }),
  );
  const off = look.equipment.find((e) => e === 'shield' || e === 'grimoire');
  if (off) g.over(part((p) => offHand(p, off, shift(rig.arms[1], [-2, 2]), pose === 'cast')));
  g.over(
    part((p) => {
      p.stamp(
        [
          '..mmmmMMMMMn..',
          '.mmMMMMMMMMMn.',
          'mmMMMMMMMMMMnn',
          'mMMMn**nMMMMnN',
          'mMMMn*+nMMMnnN',
          'mMMMnnnnMMMnnN',
          'nMMMMMMMMMMnnN',
          'nnMMMMMMMMnnN.',
          '.nnnnnnnnnnNN.',
          '..nNNNNNNNNN..',
        ],
        16 + bx,
        24 + by,
      );
      p.stamp(['.mMMMMn.', 'mMMMMMMn', 'mMN**NMn', 'nMMMMMnn', '.nnnnnn.'], 19 + bx, 19 + by);
    }),
  );
  const main = look.equipment.find((e) => MAIN.includes(e));
  g.over(
    part((p) => {
      const hand = shift(rig.arms[3], [1, 1]);
      if (main) weapon(p, main, hand, rig.weapon, pose === 'attack');
      limb(p, [29 + bx, 25 + by], hand, 2.4, 'mMn');
      disc(p, hand, 2.7, 'mMn');
    }),
  );
}

function amorphous(g: Grid, look: SpriteLook, pose: SpritePose) {
  const shape: Record<SpritePose, readonly [number, number, number, number]> = {
    idle: [24, 36.5, 11, 7],
    'step-a': [24, 37.5, 12, 6],
    'step-b': [24, 36, 10, 7.5],
    attack: [27, 37, 13.5, 6],
    recover: [25, 37, 12, 6.5],
    cast: [24, 35, 9.5, 8.5],
    jump: [24, 31, 9.5, 8],
    crouch: [24, 39, 12.5, 4.5],
    down: [24, 40.5, 13, 3],
    dodge: [20, 37, 10.5, 6.5],
    'fly-a': [24, 30, 10, 7],
    'fly-b': [24, 31, 10.5, 6.5],
  };
  const [cx, cy, rx, ry] = shape[pose];
  g.over(
    part((p) => {
      p.area([cx - rx - 1, cy - ry - 1, cx + rx + 1, cy + ry + 1], (x, y) => {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d > 1) return '.';
        const lit = ((x - cx) / rx) * LIGHT[0] + ((y - cy) / ry) * LIGHT[1];
        if (y > cy + ry * 0.55) return '4';
        return lit > 0.55 ? '1' : lit < -0.25 ? '3' : '2';
      });
      p.stamp(['ww.', 'w..'], Math.round(cx - rx * 0.55), Math.round(cy - ry * 0.6));
      if (look.equipment.some((e) => MAIN.includes(e)))
        p.stamp(['.n', 'n.'], Math.round(cx - 2), Math.round(cy + 1));
      if (pose === 'down') p.stamp(['o.o', '.o.', 'o.o'], Math.round(cx + 2), Math.round(cy - 1));
      else
        for (const x of [cx + 2, cx + 6]) {
          p.set(x, cy - 2, 'e');
          p.set(x, cy - 1, 'e');
          p.set(x, cy - 3, 'w');
        }
    }),
  );
  if (pose === 'attack')
    g.over(part((p) => limb(p, [cx + rx - 2, cy], [cx + rx + 4, cy - 2], 2, '123')));
}

const INK = rgb('#1a1320');
const WHITE = rgb('#fff8ec');
const FIXED: Record<string, string> = {
  '5': '#7a74a0',
  '6': '#544f78',
  '7': '#37334f',
  s: '#ffe2c4',
  S: '#f3bf96',
  t: '#cc8768',
  h: '#7d5442',
  H: '#52352b',
  j: '#34211f',
  m: '#f3f6fb',
  M: '#bcc6d6',
  n: '#7f8ca4',
  N: '#4d566e',
  l: '#b27c50',
  L: '#7e5334',
  k: '#51331f',
  g: '#fff0b0',
  G: '#ecbb4c',
  y: '#a86f2c',
  d: '#c08a55',
  D: '#8a5b32',
  b: '#5a381c',
  f: '#f1e6d2',
  F: '#c9b597',
  r: '#8e7c64',
  e: '#221a33',
};

function palette(look: SpriteLook, flash: boolean): Rgb[] {
  const main = rgb(look.colour),
    glow = rgb(look.glow);
  const tones: Record<string, Rgb> = {
    o: INK,
    '1': shade(main, 0.45),
    '2': main,
    '3': shade(main, -0.45),
    '4': shade(main, -0.85),
    w: WHITE,
    '*': glow,
    '+': mix(glow, WHITE, 0.65),
    x: shade(glow, 0.05),
    X: shade(glow, -0.4),
    z: shade(glow, -0.8),
    ...Object.fromEntries(Object.entries(FIXED).map(([key, hex]) => [key, rgb(hex)])),
  };
  return Array.from(KEYS, (key) =>
    key === '.' ? INK : flash && key !== 'o' ? WHITE : tones[key]!,
  );
}

/**
 * One pixel-art frame facing +x (renderers mirror it). The same look and pose always produce
 * the same pixels; nothing here reads combat state.
 */
export function spriteImage(look: SpriteLook, pose: SpritePose, flash = false): PixelImage {
  let g = new Grid();
  const figure = pose === 'down' ? 'idle' : pose;
  if (look.silhouette === 'beast') beast(g, look, pose);
  else if (look.silhouette === 'construct') {
    construct(g, look, pose);
    if (pose === 'down') g = rotateDown(g);
  } else if (look.silhouette === 'amorphous') amorphous(g, look, pose);
  else {
    humanoid(g, look, figure, look.silhouette === 'winged', pose !== 'down');
    if (pose === 'down') {
      g = rotateDown(g);
      const main = look.equipment.find((e) => MAIN.includes(e));
      if (main) g.over(part((p) => weapon(p, main, [20, 41.5], 0)));
    }
  }
  // Classic one-pixel dark outline around the whole silhouette.
  const filled = g.cells.slice();
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (
        !filled[y * N + x] &&
        NEIGHBOURS.some(([dx, dy]) => {
          const nx = x + dx,
            ny = y + dy;
          return nx >= 0 && ny >= 0 && nx < N && ny < N && filled[ny * N + nx];
        })
      )
        g.cells[y * N + x] = 1;
  const colours = palette(look, flash),
    image = blank(N, N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const cell = g.cells[y * N + x]!;
      if (cell) plot(image, x, y, colours[cell]!, 255, false);
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
