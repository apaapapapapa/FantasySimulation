import { describe, expect, it } from 'vite-plus/test';
import type { PixelImage } from './pixel-art.ts';
import {
  SPRITE_FEET,
  SPRITE_SIZE,
  spriteFade,
  spriteImage,
  spritePose,
  type PoseState,
  type SpriteLook,
  type SpritePose,
} from './pixel-sprites.ts';

const look = (changes: Partial<SpriteLook> = {}): SpriteLook => ({
  silhouette: 'humanoid',
  colour: '#64a7e4',
  equipment: [],
  glow: '#c070ff',
  ...changes,
});
const INK = [0x1a, 0x13, 0x20];
const pixel = (image: PixelImage, x: number, y: number) => [
  ...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
];
const opaque = (image: PixelImage, x: number, y: number) =>
  x >= 0 && y >= 0 && x < image.width && y < image.height && pixel(image, x, y)[3] === 255;
function rows(image: PixelImage) {
  const filled: number[] = [];
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) if (opaque(image, x, y)) filled.push(y);
  return filled;
}

describe('pixel sprites', () => {
  it.each(['humanoid', 'beast', 'construct', 'winged', 'amorphous'] as const)(
    'draws a deterministic outlined %s standing on the feet line',
    (silhouette) => {
      const image = spriteImage(look({ silhouette }), 'idle');
      expect([image.width, image.height]).toEqual([SPRITE_SIZE, SPRITE_SIZE]);
      expect(spriteImage(look({ silhouette }), 'idle').data).toEqual(image.data);
      const filled = rows(image);
      expect(filled.length).toBeGreaterThan(80);
      // The lowest body row sits on the feet line; its outline is one row below.
      expect(Math.max(...filled)).toBeGreaterThanOrEqual(SPRITE_FEET);
      expect(Math.max(...filled)).toBeLessThanOrEqual(SPRITE_FEET + 1);
      const edges: string[] = [];
      for (let y = 0; y < SPRITE_SIZE; y++)
        for (let x = 0; x < SPRITE_SIZE; x++)
          if (
            opaque(image, x, y) &&
            [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ].some(([dx, dy]) => !opaque(image, x + dx!, y + dy!))
          )
            edges.push(pixel(image, x, y).slice(0, 3).join());
      // Every pixel on the silhouette's edge is the dark outline.
      expect(edges.length).toBeGreaterThan(20);
      expect(new Set(edges)).toEqual(new Set([INK.join()]));
    },
  );
  it('paints the recorded body colour and adds each item of equipment', () => {
    const bare = spriteImage(look(), 'idle');
    const body = [0x64, 0xa7, 0xe4, 255];
    expect(
      bare.data.some(
        (_, i) => i % 4 === 0 && [...bare.data.slice(i, i + 4)].join() === body.join(),
      ),
    ).toBe(true);
    for (const item of ['blade', 'bow', 'staff', 'shield', 'spear', 'axe', 'grimoire'] as const)
      expect(spriteImage(look({ equipment: [item] }), 'idle').data).not.toEqual(bare.data);
  });
  it('draws a distinct frame for each recorded pose', () => {
    const poses: SpritePose[] = [
      'idle',
      'step-a',
      'step-b',
      'attack',
      'recover',
      'cast',
      'jump',
      'crouch',
      'down',
      'dodge',
      'fly-a',
      'fly-b',
    ];
    const frames = new Set(
      poses.map((pose) => spriteImage(look({ equipment: ['blade'] }), pose).data.join()),
    );
    expect(frames.size).toBe(poses.length);
  });
  it('turns everything but the outline white for a hit flash', () => {
    const image = spriteImage(look(), 'idle', true);
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3] !== 255) continue;
      const rgb = [...image.data.slice(i, i + 3)];
      expect(rgb.join() === INK.join() || rgb.join() === [0xff, 0xfa, 0xf0].join()).toBe(true);
    }
  });
});

describe('sprite pose selection', () => {
  const state = (changes: Partial<PoseState> = {}): PoseState => ({
    defeated: false,
    posture: 'standing',
    grounded: true,
    locomotion: { mode: 'idle', jumping: false, dodging: false },
    phase: null,
    ...changes,
  });
  const moving = (mode: 'walk' | 'run' | 'slow' | 'flight') => ({
    mode,
    jumping: false,
    dodging: false,
  });
  it('follows the recorded action, posture and locomotion in priority order', () => {
    expect(spritePose(state({ defeated: true, phase: 'active' }), 0)).toBe('down');
    expect(spritePose(state({ posture: 'prone' }), 0)).toBe('down');
    expect(spritePose(state({ phase: 'cast', locomotion: moving('run') }), 0)).toBe('cast');
    expect(spritePose(state({ phase: 'active' }), 0)).toBe('attack');
    expect(spritePose(state({ phase: 'recovery' }), 0)).toBe('recover');
    expect(
      spritePose(state({ locomotion: { mode: 'walk', jumping: false, dodging: true } }), 0),
    ).toBe('dodge');
    expect(spritePose(state({ posture: 'crouching' }), 0)).toBe('crouch');
    expect(spritePose(state({ grounded: false }), 0)).toBe('jump');
    expect(spritePose(state({ locomotion: null }), 0)).toBe('idle');
    expect(spritePose(state(), 5000)).toBe('idle');
  });
  it('cycles gait frames by the displayed step time, never by a clock', () => {
    expect(spritePose(state({ locomotion: moving('walk') }), 0)).toBe('step-a');
    expect(spritePose(state({ locomotion: moving('walk') }), 180)).toBe('step-b');
    expect(spritePose(state({ locomotion: moving('walk') }), 360)).toBe('step-a');
    expect(spritePose(state({ locomotion: moving('run') }), 110)).toBe('step-b');
    expect(spritePose(state({ locomotion: moving('flight'), grounded: false }), 0)).toBe('fly-a');
    expect(spritePose(state({ locomotion: moving('flight'), grounded: false }), 150)).toBe('fly-b');
  });
});

it('keeps a phased sprite translucent but whole, and visible through the terrain it enters', () => {
  // Texels are fully opaque (alpha 1) or clear (alpha 0); the material multiplies them by opacity
  // before the cutoff, so the cutoff must stay between 0 and the opacity.
  for (const phasing of [null, { pending: false }, { pending: true }]) {
    const { opacity, alphaTest, throughTerrain } = spriteFade(phasing);
    expect(alphaTest).toBeGreaterThan(0);
    expect(alphaTest).toBeLessThan(opacity);
    expect(throughTerrain).toBe(phasing !== null);
    expect(opacity < 1).toBe(phasing !== null);
  }
  expect(spriteFade({ pending: true }).opacity).toBeLessThan(
    spriteFade({ pending: false }).opacity,
  );
});
