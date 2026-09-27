import { useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import {
  AdditiveBlending,
  DoubleSide,
  NormalBlending,
  PlaneGeometry,
  Vector2,
  Vector3,
  type Group,
  type Mesh,
  type Matrix4,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { useAfterimages } from './afterimages.ts';
import { groundBelow } from './ground.ts';
import {
  SPRITE_FEET,
  SPRITE_FIGURE,
  SPRITE_SIZE,
  spriteFade,
  spritePixelScale,
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
  mine = new Vector3();
/** Drawing-buffer size shared by every sprite material. */
const BUFFER = { value: new Vector2(1, 1) };
/** Screen offset (CSS px) that lifts a later name plate above an overlapping earlier one. */
const PLATE_LIFT = 18;
/**
 * A classic sprite: the mesh scale is its size in drawing-buffer pixels and its feet are snapped
 * to the pixel grid, so every texel covers the same whole number of pixels at any distance. Each
 * row is still written at the depth of an upright body at that height, so terrain behind the
 * fighter never cuts through it.
 */
function uprightSprite(shader: WebGLProgramParametersWithUniforms) {
  shader.uniforms.bufferSize = BUFFER;
  shader.vertexShader = `uniform vec2 bufferSize;\n${shader.vertexShader.replace(
    '#include <project_vertex>',
    `vec4 anchor = viewMatrix * vec4(modelMatrix[3].xyz, 1.0);
    vec2 pixels = vec2(transformed.x * modelMatrix[0].x, transformed.y * modelMatrix[1].y);
    float perPixel = -anchor.z * 2.0 / (projectionMatrix[1][1] * bufferSize.y);
    vec3 worldUp = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    float depth = min(anchor.z + pixels.y * perPixel * worldUp.z / max(worldUp.y, 0.45), anchor.z * 0.2);
    vec4 mvPosition = vec4(anchor.xy, depth, 1.0);
    vec4 feet = projectionMatrix * anchor;
    vec2 snapped = floor((feet.xy / feet.w * 0.5 + 0.5) * bufferSize + 0.5);
    vec4 clip = projectionMatrix * mvPosition;
    gl_Position = vec4(((snapped + pixels) / bufferSize * 2.0 - 1.0) * clip.w, clip.z, clip.w);`,
  )}`;
}
/** View-space distance in front of the camera. */
const depthOf = (camera: { matrixWorldInverse: Matrix4 }, p: readonly number[]) =>
  Math.max(0.1, -mine.set(p[0]!, p[1]!, p[2]!).applyMatrix4(camera.matrixWorldInverse).z);

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
    plate = useRef<HTMLDivElement>(null),
    plateAnchor = useRef<Group>(null);
  const viewport = useThree((state) => state.size);
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
  useFrame(({ camera, gl, controls }) => {
    const rows = gl.getDrawingBufferSize(BUFFER.value).y;
    // One pixel scale for everyone at the framed distance, from the saved standing height.
    const focus = (controls as { target?: Vector3 } | null)?.target;
    const reference = focus
      ? depthOf(camera, focus.toArray())
      : depthOf(camera, [x, actor.feet, z]);
    const perMetre = (rows * camera.projectionMatrix.elements[5]!) / (2 * reference);
    const pixels = (other: Actor) => spritePixelScale(other.standingHeight, perMetre);
    const scale = SPRITE_SIZE * pixels(actor);
    // Sprites are drawn facing +x; mirror them when the recorded facing points left on screen.
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    sprite.current?.scale.set(facing.dot(right) < 0 ? -scale : scale, scale, 1);
    // Name plates sit just above the drawn head: the feet on screen, raised by the figure.
    const plateAt = (other: Actor) => {
      const v = new Vector3(other.position[0], other.feet, other.position[2]).project(camera);
      return v.setY(v.y + (2 * (SPRITE_FIGURE + 2) * pixels(other)) / rows);
    };
    const onScreen = (v: Vector3) =>
      [((v.x + 1) / 2) * viewport.width, ((1 - v.y) / 2) * viewport.height] as const;
    const top = plateAt(actor);
    const [sx, sy] = onScreen(top);
    top.unproject(camera);
    plateAnchor.current?.position.set(top.x - x, top.y - actor.feet, top.z - z);
    // Name plates of fighters standing close together would overlap: lift the later one.
    const element = plate.current;
    if (!element) return;
    const width = element.offsetWidth;
    const covered = model.actors.slice(0, index).some((other) => {
      const [ox, oy] = onScreen(plateAt(other));
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
      <group ref={plateAnchor} position={[0, actor.standingHeight * 1.2, 0]}>
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
