import { useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Billboard, Html } from '@react-three/drei';
import {
  AdditiveBlending,
  DoubleSide,
  NormalBlending,
  PlaneGeometry,
  Vector3,
  type Mesh,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { useAfterimages } from './afterimages.ts';
import { groundBelow } from './ground.ts';
import {
  SPRITE_FEET,
  SPRITE_FIGURE,
  SPRITE_SIZE,
  spriteFade,
  spritePose,
} from './pixel-sprites.ts';
import type { SceneModel } from './scene-model.ts';
import { glowMap, spriteTexture } from './textures.ts';
import { tintColours } from './tint-colours.ts';

type Actor = SceneModel['actors'][number];
/** Ground-ring colour by participant order, matching the warm/cool sides of the arena. */
const SIDES = ['#f6c26a', '#7cc8ff'] as const;
const LIGHTS = ['#ffb566', '#ffc98c'] as const;
/** A recorded hit flashes the struck sprite on alternate steps for this many steps. */
const FLASH_STEPS = 5;
/** Unit quad whose bottom edge is the sprite's feet line. */
const QUAD = new PlaneGeometry(1, 1).translate(
  0,
  0.5 - (SPRITE_SIZE - SPRITE_FEET - 1) / SPRITE_SIZE,
  0,
);
const right = new Vector3(),
  up = new Vector3(),
  mine = new Vector3(),
  theirs = new Vector3();
/** Screen offset (CSS px) that lifts a later name plate above an overlapping earlier one. */
const PLATE_LIFT = 18;
/**
 * Screen-aligned like a classic sprite (no keystone shear), but each row is written at the depth
 * of an upright body at that height, so terrain behind the fighter never cuts through it.
 */
function uprightSprite(shader: WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    `vec4 mvPosition = viewMatrix * vec4(modelMatrix[3].xyz, 1.0);
    vec2 offset = vec2(transformed.x * modelMatrix[0].x, transformed.y * modelMatrix[1].y);
    vec3 worldUp = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    mvPosition.xy += offset;
    // Move toward the camera by the upright-body depth, rescaling x/y to keep the projection.
    float depth = min(mvPosition.z + offset.y * worldUp.z / max(worldUp.y, 0.45), mvPosition.z * 0.2);
    mvPosition.xyz = vec3(mvPosition.xy * depth / mvPosition.z, depth);
    gl_Position = projectionMatrix * mvPosition;`,
  );
}

function GroundMark({
  scale,
  opacity,
  kind,
  colour,
  additive = true,
  spin = 0,
}: {
  scale: number;
  opacity: number;
  kind: 'soft' | 'ring' | 'runes';
  colour: string;
  additive?: boolean;
  spin?: number;
}) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, spin]} scale={scale} renderOrder={1}>
      <planeGeometry />
      <meshBasicMaterial
        map={glowMap(kind)}
        color={colour}
        transparent
        opacity={opacity}
        depthWrite={false}
        blending={additive ? AdditiveBlending : NormalBlending}
        toneMapped={false}
      />
    </mesh>
  );
}

function Fighter({
  actor,
  index,
  model,
  flash,
  portal,
}: {
  actor: Actor;
  index: number;
  model: SceneModel;
  flash: boolean;
  portal: RefObject<HTMLElement>;
}) {
  const sprite = useRef<Mesh>(null),
    plate = useRef<HTMLDivElement>(null);
  const viewport = useThree((state) => state.size);
  const size = (SPRITE_SIZE * actor.standingHeight) / SPRITE_FIGURE;
  const texture = spriteTexture(
    {
      silhouette: actor.look.silhouette,
      colour: actor.colour,
      equipment: actor.look.equipment,
      glow: tintColours(actor.signature ?? 'arcane').glow,
    },
    spritePose(actor.pose, model.milliseconds),
    flash,
  );
  const [x, , z] = actor.position;
  const ground = groundBelow(model.obstacles, [x, actor.feet, z], model.min[1], actor.radius);
  const lift = Math.max(0, actor.feet - ground);
  const near = Math.max(0.3, 1 - lift / 10);
  const facing = new Vector3(actor.facing[0], 0, actor.facing[2]);
  useFrame(({ camera }) => {
    // Sprites are drawn facing +x; mirror them when the recorded facing points left on screen.
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    sprite.current?.scale.set(facing.dot(right) < 0 ? -size : size, size, 1);
    // Name plates of fighters standing close together would overlap: lift the later one.
    const element = plate.current;
    if (!element) return;
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    const screen = (v: Vector3, p: readonly number[], height: number) => {
      v.set(p[0]!, p[1]!, p[2]!).addScaledVector(up, height).project(camera);
      return [((v.x + 1) / 2) * viewport.width, ((1 - v.y) / 2) * viewport.height] as const;
    };
    const [sx, sy] = screen(mine, [x, actor.feet, z], size * 0.8);
    const width = element.offsetWidth;
    const covered = model.actors.slice(0, index).some((other) => {
      const [ox, oy] = screen(
        theirs,
        [other.position[0], other.feet, other.position[2]],
        (SPRITE_SIZE * other.standingHeight * 0.8) / SPRITE_FIGURE,
      );
      return Math.abs(ox - sx) < width + 4 && Math.abs(oy - sy) < PLATE_LIFT + 4;
    });
    element.style.setProperty('--lift', covered ? `${PLATE_LIFT}px` : '0px');
  });
  const hp = actor.hp && Math.max(0, Math.min(1, actor.hp.value / Math.max(1, actor.hp.max)));
  const fade = spriteFade(actor.phasing);
  return (
    <group position={[x, actor.feet, z]}>
      <group position={[0, ground - actor.feet + 0.02, 0]}>
        <GroundMark
          kind="soft"
          colour="#000000"
          additive={false}
          scale={actor.radius * 3.4 * near}
          opacity={0.6 * near}
        />
        <GroundMark
          kind="ring"
          colour={SIDES[index % 2]!}
          scale={actor.radius * 3.6}
          opacity={0.5 * near}
        />
      </group>
      {actor.pose.phase === 'cast' && (
        <group position={[0, 0.05, 0]}>
          <GroundMark
            kind="runes"
            colour={tintColours(actor.tint).glow}
            scale={2.6}
            opacity={0.85}
            spin={model.milliseconds / 900}
          />
        </group>
      )}
      {(actor.sealing || actor.revived) && (
        <group position={[0, actor.standingHeight * 0.45, 0]}>
          <GroundMark
            kind="runes"
            colour={actor.revived ? '#72e0c1' : '#d9a6ff'}
            scale={actor.radius * 5}
            opacity={0.9}
            spin={-model.milliseconds / 1200}
          />
        </group>
      )}
      <pointLight
        position={[0, 1.7, 0.4]}
        color={LIGHTS[index % 2]!}
        intensity={14}
        distance={12}
        decay={1.4}
      />
      <mesh
        ref={sprite}
        geometry={QUAD}
        position={[0, 0.02, 0]}
        renderOrder={fade.throughTerrain ? 5 : 2}
        frustumCulled={false}
      >
        <meshBasicMaterial
          map={texture}
          alphaTest={fade.alphaTest}
          transparent={fade.opacity < 1}
          opacity={fade.opacity}
          depthTest={!fade.throughTerrain}
          side={DoubleSide}
          toneMapped={false}
          onBeforeCompile={uprightSprite}
          customProgramCacheKey={() => 'upright-sprite'}
        />
      </mesh>
      <Billboard>
        <group position={[0, size * 0.8, 0]}>
          <Html portal={portal} zIndexRange={[40, 31]} pointerEvents="none">
            <div
              ref={plate}
              className="fighter-plate"
              data-side={index % 2 ? 'right' : 'left'}
              aria-hidden="true"
            >
              <span>{actor.name}</span>
              {hp !== null && (
                <i>
                  <b style={{ width: `${hp * 100}%` }} />
                </i>
              )}
            </div>
          </Html>
        </group>
      </Billboard>
    </group>
  );
}

/** Pixel sprites chosen from recorded pose/state; the white capsule overlay stays the hitbox. */
export function SceneFighters({
  model,
  portal,
}: {
  model: SceneModel;
  /** Stable DOM parent for name plates (drei's default target can change after mount). */
  portal: RefObject<HTMLElement>;
}) {
  const struck = useAfterimages(
    model,
    model.actors.filter((a) => a.struck).map((a) => a.id),
    model.step,
    FLASH_STEPS,
  );
  // Flicker on alternate steps counted from the latest recorded strike.
  const flashing = (id: string) => {
    const latest = Math.max(-Infinity, ...struck.filter((m) => m.item === id).map((m) => m.step));
    return (model.step - latest) % 2 === 0;
  };
  return (
    <>
      {model.actors.map((actor, index) => (
        <Fighter
          key={actor.id}
          actor={actor}
          index={index}
          model={model}
          portal={portal}
          flash={flashing(actor.id)}
        />
      ))}
    </>
  );
}
