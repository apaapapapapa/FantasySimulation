import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { AdditiveBlending, BufferGeometry, Color, DoubleSide, Float32BufferAttribute } from 'three';
import { afterimageStrength, useAfterimages, type Afterimage } from './afterimages.ts';
import { groundBelow } from './ground.ts';
import { prng } from './pixel-art.ts';
import type { Point, SceneModel } from './scene-model.ts';
import { glowMap } from './textures.ts';
import { tintColours } from './tint-colours.ts';

type Shape = SceneModel['shapes'][number];
const DEFLECTED = '#72e0c1';
const SPANS = { burst: 14, slash: 7, orb: 6, beam: 4, trail: 10 } as const;

function Glow({
  position,
  scale,
  colour,
  opacity,
  kind = 'soft',
}: {
  position: Point;
  scale: number;
  colour: string;
  opacity: number;
  kind?: 'soft' | 'burst' | 'ring';
}) {
  return (
    <sprite position={position} scale={[scale, scale, 1]} renderOrder={3}>
      <spriteMaterial
        map={glowMap(kind)}
        color={colour}
        transparent
        opacity={opacity}
        depthWrite={false}
        blending={AdditiveBlending}
        toneMapped={false}
      />
    </sprite>
  );
}

/**
 * Crescent bands along the blade (fraction from root → tip, alpha, bright rim?): transparent
 * inside, an orange glow, then a bright rim at the recorded tip.
 */
const SLASH_BANDS = [
  [0.5, 0, false],
  [0.84, 0.55, false],
  [1, 1, true],
] as const;
/**
 * Ribbons between the recorded blade poses (root → tip) of recent steps: each pose pair and band
 * becomes one quad, so the swing reads like a Dimraeth-style slash arc.
 */
function Slashes({ marks, step }: { marks: readonly Afterimage<Shape>[]; step: number }) {
  const geometry = useMemo(() => {
    const groups = new Map<
      string,
      { strength: number; colour: Color; core: Color; poses: Shape[] }
    >();
    for (const mark of marks) {
      const key = `${mark.step}:${mark.item.group}`;
      const colours = tintColours(mark.item.tint);
      if (!groups.has(key))
        groups.set(key, {
          strength: afterimageStrength(mark, step, SPANS.slash),
          colour: new Color(colours.glow),
          core: new Color(colours.core),
          poses: [],
        });
      groups.get(key)!.poses.push(mark.item);
    }
    const positions: number[] = [],
      colours: number[] = [];
    const along = ([root, tip]: [Point, Point], t: number) =>
      root.map((n, i) => n + (tip[i]! - n) * t) as Point;
    for (const { strength, colour, core, poses } of groups.values())
      for (let i = 0; i + 1 < poses.length; i++)
        for (let b = 0; b + 1 < SLASH_BANDS.length; b++) {
          const [t0, a0, rim0] = SLASH_BANDS[b]!,
            [t1, a1, rim1] = SLASH_BANDS[b + 1]!;
          const p0 = poses[i]!.points,
            p1 = poses[i + 1]!.points;
          const corners = [
            [along(p0, t0), a0, rim0],
            [along(p0, t1), a1, rim1],
            [along(p1, t1), a1, rim1],
            [along(p1, t0), a0, rim0],
          ] as const;
          for (const k of [0, 1, 2, 0, 2, 3]) {
            const [p, alpha, rim] = corners[k]!;
            const c = rim ? core : colour;
            positions.push(...p);
            colours.push(c.r, c.g, c.b, alpha * strength);
          }
        }
    const value = new BufferGeometry();
    value.setAttribute('position', new Float32BufferAttribute(positions, 3));
    value.setAttribute('color', new Float32BufferAttribute(colours, 4));
    return value;
  }, [marks, step]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} renderOrder={3}>
      <meshBasicMaterial
        vertexColors
        transparent
        side={DoubleSide}
        depthWrite={false}
        blending={AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  );
}

function SpatialObject({
  object,
  model,
}: {
  object: SceneModel['objects'][number];
  model: SceneModel;
}) {
  const colours = object.tint ? tintColours(object.tint) : { glow: object.colour, core: '#ffffff' };
  const shape = object.shape;
  const volume = (wireframe: boolean) => (
    <meshBasicMaterial
      color={colours.glow}
      transparent
      opacity={wireframe ? 0.5 : 0.14}
      wireframe={wireframe}
      depthWrite={false}
      blending={AdditiveBlending}
      toneMapped={false}
    />
  );
  const ground =
    object.kind === 'area' && shape?.kind === 'sphere'
      ? groundBelow(model.obstacles, object.position, model.min[1])
      : null;
  // One geometry element and one transform for the volume and the barrier outline, so the
  // outline always shares the saved yaw of the shape it traces.
  const geometry = (segments: number) =>
    shape?.kind === 'box' ? (
      <boxGeometry args={[shape.sizeMm.x / 1000, shape.sizeMm.y / 1000, shape.sizeMm.z / 1000]} />
    ) : shape?.kind === 'sphere' ? (
      <icosahedronGeometry args={[shape.radiusMm / 1000, segments > 10 ? 2 : 1]} />
    ) : shape ? (
      <cylinderGeometry
        args={[shape.radiusMm / 1000, shape.radiusMm / 1000, shape.heightMm / 1000, segments]}
      />
    ) : null;
  return (
    <group>
      {shape && (
        <group
          position={object.position}
          rotation={
            shape.kind === 'box' ? [0, (shape.yawMilliDegrees * Math.PI) / 180000, 0] : [0, 0, 0]
          }
        >
          <mesh>
            {geometry(20)}
            {volume(false)}
          </mesh>
          {object.kind === 'barrier' && (
            <mesh>
              {geometry(10)}
              {volume(true)}
            </mesh>
          )}
        </group>
      )}
      {ground !== null && shape?.kind === 'sphere' && (
        <mesh
          position={[object.position[0], ground + 0.03, object.position[2]]}
          rotation={[-Math.PI / 2, 0, model.milliseconds / 1100]}
          scale={(shape.radiusMm / 1000) * 2}
        >
          <planeGeometry />
          <meshBasicMaterial
            map={glowMap('runes')}
            color={colours.glow}
            transparent
            opacity={0.8}
            depthWrite={false}
            blending={AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      )}
      {object.beams.map((b) => (
        <group key={b.id}>
          <Line
            points={b.points}
            color={colours.glow}
            lineWidth={Math.max(4, b.radius * 40)}
            transparent
            opacity={0.85}
          />
          <Line points={b.points} color={colours.core} lineWidth={1.5} />
        </group>
      ))}
    </group>
  );
}

const FIREFLY_CELL = 9,
  FIREFLIES_PER_CELL = 5;
/**
 * Decorative motes in world-anchored cells around the fighters. Their drift is keyed to the
 * displayed step time, so a paused or shared step always shows the same arrangement.
 */
function Fireflies({ model }: { model: SceneModel }) {
  const dpr = useThree((state) => state.viewport.dpr);
  const centre = model.actors.length
    ? ([0, 1, 2].map(
        (i) => model.actors.reduce((sum, a) => sum + a.position[i]!, 0) / model.actors.length,
      ) as Point)
    : model.centre;
  const floor = groundBelow(model.obstacles, [centre[0], centre[1] + 2, centre[2]], model.min[1]);
  const cx = Math.floor(centre[0] / FIREFLY_CELL),
    cz = Math.floor(centre[2] / FIREFLY_CELL);
  const positions = useMemo(() => {
    const out: number[] = [];
    const seconds = model.milliseconds / 1000;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const random = prng(`firefly:${cx + i}:${cz + j}`);
        for (let n = 0; n < FIREFLIES_PER_CELL; n++) {
          const x = (cx + i + random()) * FIREFLY_CELL,
            z = (cz + j + random()) * FIREFLY_CELL,
            y = floor + 0.5 + random() * 2.4;
          const t = seconds * (0.35 + random() * 0.5) + random() * Math.PI * 2;
          out.push(x + Math.sin(t) * 0.9, y + Math.sin(t * 1.7) * 0.3, z + Math.cos(t * 0.8) * 0.9);
        }
      }
    return new Float32Array(out);
  }, [cx, cz, floor, model.milliseconds]);
  return (
    <points renderOrder={4}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={2 / dpr}
        sizeAttenuation={false}
        color="#efffa6"
        transparent
        opacity={0.8}
        depthWrite={false}
        blending={AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
}

/** Glowing marks for recorded projectiles, attack geometry, events and spatial objects. */
export function SceneEffects({ model }: { model: SceneModel }) {
  const { step } = model;
  const actorIds = new Set(model.actors.map((a) => a.id));
  const bursts = useAfterimages(model, model.effects, step, SPANS.burst);
  const slashes = useAfterimages(
    model,
    model.shapes.filter((s) => s.kind === 'blade'),
    step,
    SPANS.slash,
  );
  const orbs = useAfterimages(
    model,
    model.shapes.filter((s) => s.kind === 'sphere'),
    step,
    SPANS.orb,
  );
  const beams = useAfterimages(
    model,
    model.shapes.filter((s) => s.kind === 'ray'),
    step,
    SPANS.beam,
  );
  const tints = new Map(
    model.projectiles.map((p) => [p.id, p.deflected ? DEFLECTED : tintColours(p.tint).glow]),
  );
  // The colour is kept with each trail segment: the projectile may be gone a step later.
  const trails = useAfterimages(
    model,
    model.paths
      .filter((p) => !actorIds.has(p.entityId))
      .map((p) => ({ ...p, colour: p.deflected ? DEFLECTED : tintColours(p.tint).glow })),
    step,
    SPANS.trail,
  );
  return (
    <>
      {trails.map((mark) => (
        <Line
          key={`${mark.step}:${mark.item.id}`}
          points={mark.item.points}
          color={mark.item.colour}
          lineWidth={3}
          transparent
          opacity={afterimageStrength(mark, step, SPANS.trail) * 0.8}
        />
      ))}
      {model.projectiles.map((p) => {
        const colours = tintColours(p.tint);
        return (
          <group key={p.id}>
            <mesh position={p.position}>
              <sphereGeometry args={[Math.max(0.06, p.radius), 10, 8]} />
              <meshBasicMaterial
                color={p.deflected ? DEFLECTED : colours.core}
                toneMapped={false}
              />
            </mesh>
            <Glow
              position={p.position}
              scale={Math.max(0.5, p.radius * 7)}
              colour={tints.get(p.id)!}
              opacity={0.9}
            />
          </group>
        );
      })}
      <Slashes marks={slashes} step={step} />
      {orbs.map((mark) => (
        <Glow
          key={`${mark.step}:${mark.item.id}`}
          position={mark.item.points[1]}
          scale={Math.max(0.4, mark.item.radius * 3)}
          colour={tintColours(mark.item.tint).glow}
          opacity={afterimageStrength(mark, step, SPANS.orb) * 0.8}
        />
      ))}
      {beams.map((mark) => {
        const colours = tintColours(mark.item.tint),
          strength = afterimageStrength(mark, step, SPANS.beam);
        return (
          <group key={`${mark.step}:${mark.item.id}`}>
            <Line
              points={mark.item.points}
              color={colours.glow}
              lineWidth={Math.max(4, mark.item.radius * 40)}
              transparent
              opacity={strength * 0.85}
            />
            <Line
              points={mark.item.points}
              color={colours.core}
              lineWidth={1.5}
              transparent
              opacity={strength}
            />
          </group>
        );
      })}
      {bursts.map((mark) => {
        const strength = afterimageStrength(mark, step, SPANS.burst),
          grow = 1 - strength,
          { kind, position, tint } = mark.item;
        const colour = kind === 'projectile-deflect' ? DEFLECTED : tintColours(tint).glow;
        return kind === 'hit' ? (
          <group key={`${mark.step}:${mark.item.id}`}>
            <Glow
              position={position}
              kind="soft"
              scale={1.6 + grow}
              colour={colour}
              opacity={strength * 0.8}
            />
            <Glow
              position={position}
              kind="burst"
              scale={1.1 + grow * 1.6}
              colour={colour}
              opacity={strength}
            />
            <Glow
              position={position}
              kind="burst"
              scale={0.6 + grow * 0.6}
              colour={tintColours(tint).core}
              opacity={strength}
            />
            <Glow
              position={position}
              kind="ring"
              scale={0.5 + grow * 2.8}
              colour={tintColours(tint).core}
              opacity={strength * 0.8}
            />
          </group>
        ) : (
          <Glow
            key={`${mark.step}:${mark.item.id}`}
            position={position}
            kind={kind === 'launch' ? 'soft' : 'ring'}
            scale={0.5 + grow * 1.2}
            colour={colour}
            opacity={strength * 0.8}
          />
        );
      })}
      {model.objects.map((o) => (
        <SpatialObject key={o.id} object={o} model={model} />
      ))}
      <Fireflies model={model} />
    </>
  );
}
