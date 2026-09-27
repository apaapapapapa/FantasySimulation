import { BoxGeometry, CylinderGeometry, MeshLambertMaterial, type BufferGeometry } from 'three';
import type { TerrainKind } from './pixel-art.ts';
import type { SceneModel } from './scene-model.ts';
import {
  MEADOW_METRES,
  TERRAIN_TEXELS_PER_METRE,
  TILE_SIZE,
  meadowTexture,
  terrainTexture,
} from './textures.ts';

type Obstacle = SceneModel['obstacles'][number];
/** Dimraeth-like ruins: grassy tops over mossy stone unless the saved material says otherwise. */
const SURFACES: Record<Obstacle['material'], { top: TerrainKind; side: TerrainKind }> = {
  generic: { top: 'grass', side: 'mossy-bricks' },
  stone: { top: 'flagstone', side: 'bricks' },
  wood: { top: 'planks', side: 'planks' },
  metal: { top: 'plates', side: 'plates' },
  earth: { top: 'dirt', side: 'earth-wall' },
};
const PILLAR = { top: 'flagstone', side: 'bricks' } as const;
const scale = (kind: TerrainKind) => TERRAIN_TEXELS_PER_METRE / TILE_SIZE[kind];

/** World-anchored UVs keep one texel density on every face and line up neighbouring blocks. */
function boxGeometry(
  size: readonly number[],
  centre: readonly number[],
  surface: { top: TerrainKind; side: TerrainKind },
) {
  const geometry = new BoxGeometry(size[0], size[1], size[2]);
  const position = geometry.getAttribute('position'),
    uv = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i++) {
    const face = Math.floor(i / 4);
    const x = position.getX(i) + centre[0]!,
      y = position.getY(i) + centre[1]!,
      z = position.getZ(i) + centre[2]!;
    const top = face === 2 || face === 3;
    const s = scale(top ? surface.top : surface.side);
    const [u, v] = top ? [x, -z] : face < 2 ? [z, y] : [x, y];
    uv.setXY(i, u * s, v * s);
  }
  return geometry;
}
function pillarGeometry(radius: number, height: number) {
  const geometry = new CylinderGeometry(radius, radius, height, 20, 1);
  const position = geometry.getAttribute('position'),
    uv = geometry.getAttribute('uv');
  const side = scale(PILLAR.side),
    top = scale(PILLAR.top);
  // The 21×2 wall vertices come first; the caps follow.
  for (let i = 0; i < position.count; i++) {
    if (i >= 42) uv.setXY(i, position.getX(i) * top, position.getZ(i) * top);
    else
      uv.setXY(i, uv.getX(i) * 2 * Math.PI * radius * side, (position.getY(i) + height / 2) * side);
  }
  return geometry;
}

/**
 * Grass tops sample a world-space meadow mask: dirt clearings with a dark grass rim and broad
 * brightness drift, so a large floor does not show the tile grid.
 */
function meadow(value: MeshLambertMaterial) {
  value.onBeforeCompile = (shader) => {
    shader.uniforms.meadowDirt = { value: terrainTexture('dirt') };
    shader.uniforms.meadowMask = { value: meadowTexture() };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMeadow;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvMeadow = (modelMatrix * vec4(transformed, 1.0)).xz / ${MEADOW_METRES.toFixed(1)};`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D meadowDirt;\nuniform sampler2D meadowMask;\nvarying vec2 vMeadow;',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec4 meadow = texture2D(meadowMask, vMeadow);
        float clearing = step(0.63, meadow.r);
        float rim = step(0.6, meadow.r) * (1.0 - clearing);
        diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(meadowDirt, vMapUv).rgb, clearing);
        diffuseColor.rgb *= (1.0 - 0.35 * rim) * (0.8 + 0.4 * meadow.g);`,
      );
  };
  value.customProgramCacheKey = () => 'meadow';
}

const materials = new Map<string, MeshLambertMaterial>();
function material(kind: TerrainKind, solid: boolean, overhead: boolean) {
  const key = `${kind}:${solid}:${overhead}`;
  let value = materials.get(key);
  if (!value) {
    value = new MeshLambertMaterial({
      map: terrainTexture(kind),
      // Terrain that does not block movement stays visibly darker, as before.
      color: solid ? '#ffffff' : '#8a8f9c',
      transparent: overhead,
      opacity: overhead ? 0.16 : 1,
      depthWrite: !overhead,
    });
    if (kind === 'grass') meadow(value);
    materials.set(key, value);
  }
  return value;
}
/** Model objects are rebuilt every step, so geometry is cached by its recorded dimensions. */
const geometries = new Map<string, BufferGeometry>();
function geometry(obstacle: Obstacle) {
  const key =
    obstacle.kind === 'cylinder'
      ? `c:${obstacle.radius}:${obstacle.height}`
      : `b:${obstacle.size.join()}:${obstacle.position.join()}:${obstacle.material}`;
  let value = geometries.get(key);
  if (!value) {
    value =
      obstacle.kind === 'cylinder'
        ? pillarGeometry(obstacle.radius, obstacle.height)
        : boxGeometry(obstacle.size, obstacle.position, SURFACES[obstacle.material]);
    geometries.set(key, value);
  }
  return value;
}

function Block({ obstacle, overhead }: { obstacle: Obstacle; overhead: boolean }) {
  const surface = obstacle.kind === 'cylinder' ? PILLAR : SURFACES[obstacle.material];
  const side = material(surface.side, obstacle.solid, overhead),
    top = material(surface.top, obstacle.solid, overhead);
  return (
    <mesh
      geometry={geometry(obstacle)}
      position={obstacle.position}
      rotation={obstacle.kind === 'box' ? obstacle.rotation : [0, 0, 0]}
      material={obstacle.kind === 'box' ? [side, side, top, side, side, side] : [side, top, top]}
      renderOrder={overhead ? 2 : 0}
    />
  );
}

/**
 * Recorded obstacles only, textured by their saved material. Terrain entirely above every
 * fighter's head (a ceiling) is drawn as a faint cutaway so the quarter view can see inside.
 */
export function SceneTerrain({ model }: { model: SceneModel }) {
  const head = Math.max(...model.actors.map((a) => a.feet + a.standingHeight));
  return (
    <>
      {model.obstacles.map((o) => {
        const bottom = o.position[1] - (o.kind === 'box' ? o.size[1] / 2 : o.height / 2);
        return <Block key={o.id} obstacle={o} overhead={bottom > head + 0.25} />;
      })}
    </>
  );
}
