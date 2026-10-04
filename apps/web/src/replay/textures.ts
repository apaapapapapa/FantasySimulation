import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  NoColorSpace,
  NearestMipmapNearestFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import {
  glowTexture,
  meadowMask,
  terrainTile,
  type GlowKind,
  type PixelImage,
  type TerrainKind,
} from './pixel-art.ts';
import { spriteImage, type SpriteLook, type SpritePose } from './pixel-sprites.ts';

/** Texels per metre on terrain; close to one screen pixel per texel at the framed distance. */
export const TERRAIN_TEXELS_PER_METRE = 12;

/** Uploads a top-down image bottom-up, as WebGL expects, with crisp nearest sampling. */
function upload(image: PixelImage, repeat: boolean) {
  const rows = new Uint8Array(image.data.length),
    stride = image.width * 4;
  for (let y = 0; y < image.height; y++)
    rows.set(image.data.subarray(y * stride, (y + 1) * stride), (image.height - 1 - y) * stride);
  const texture = new DataTexture(rows, image.width, image.height, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = repeat ? NearestMipmapNearestFilter : NearestFilter;
  texture.generateMipmaps = repeat;
  if (repeat) texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

const cache = new Map<string, DataTexture>();
const cached = (key: string, create: () => DataTexture) => {
  let texture = cache.get(key);
  if (!texture) cache.set(key, (texture = create()));
  return texture;
};
export const TILE_SIZE: Record<TerrainKind, number> = {
  grass: 128,
  dirt: 128,
  flagstone: 64,
  bricks: 64,
  'mossy-bricks': 64,
  planks: 64,
  plates: 64,
  'earth-wall': 64,
};
export const terrainTexture = (kind: TerrainKind) =>
  cached(`terrain:${kind}`, () => {
    const texture = upload(terrainTile(kind, TILE_SIZE[kind]), true);
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.anisotropy = 4;
    return texture;
  });
/** World-space metres covered by one repeat of the meadow mask. */
export const MEADOW_METRES = 96;
export const meadowTexture = () =>
  cached('meadow', () => {
    const texture = upload(meadowMask(), false);
    // A data mask, not a colour: keep it linear and smooth so thresholds give crisp contours.
    texture.colorSpace = NoColorSpace;
    texture.magFilter = texture.minFilter = LinearFilter;
    texture.wrapS = texture.wrapT = RepeatWrapping;
    return texture;
  });
export const glowMap = (kind: GlowKind) =>
  cached(`glow:${kind}`, () => {
    const texture = upload(glowTexture(kind, 96), false);
    texture.magFilter = texture.minFilter = LinearFilter;
    return texture;
  });
export const spriteTexture = (look: SpriteLook, pose: SpritePose, flash: boolean) =>
  cached(
    `sprite:${look.silhouette}:${look.colour}:${look.glow}:${look.equipment.join(',')}:${pose}:${flash}`,
    () => upload(spriteImage(look, pose, flash), false),
  );
