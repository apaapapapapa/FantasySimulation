import { conceptMark } from './concept-mark.ts';
import { useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { AdditiveBlending, NormalBlending, Vector3 } from 'three';
import { useAfterimages } from './afterimages.ts';
import { groundBelow } from './ground.ts';
import { FighterFigure } from './FighterFigure.tsx';
import type { SceneModel } from './scene-model.ts';
import { glowMap } from './textures.ts';
import { tintColours } from './tint-colours.ts';

type Actor = SceneModel['actors'][number];
/** Ground-ring colour by participant order, matching the warm/cool sides of the arena. */
const SIDES = ['#d9bc83', '#94cbbd'] as const;
/** A recorded hit flashes the struck miniature on alternate steps for this many steps. */
const FLASH_STEPS = 5;
/** Screen-space clearance between nearby labels. */
const PLATE_LIFT = 28;

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
  const plate = useRef<HTMLDivElement>(null);
  const viewport = useThree((state) => state.size);
  const [x, , z] = actor.position;
  const ground = groundBelow(model.obstacles, [x, actor.feet, z], model.min[1], actor.radius);
  const lift = Math.max(0, actor.feet - ground);
  const near = Math.max(0.3, 1 - lift / 10);
  useFrame(({ camera }) => {
    const plateAt = (other: Actor) =>
      new Vector3(
        other.position[0],
        other.feet + other.standingHeight * 1.35,
        other.position[2],
      ).project(camera);
    const onScreen = (v: Vector3) =>
      [((v.x + 1) / 2) * viewport.width, ((1 - v.y) / 2) * viewport.height] as const;
    const [sx, sy] = onScreen(plateAt(actor));
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
  return (
    <>
      <FighterFigure actor={actor} milliseconds={model.milliseconds} flash={flash} />
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
        {(actor.sealing ||
          actor.revived ||
          actor.protected ||
          actor.defeated ||
          actor.frozen ||
          actor.evaded) && (
          <group position={[0, actor.standingHeight * 0.45, 0]}>
            <GroundMark
              kind="runes"
              colour={conceptMark(actor).colour}
              scale={actor.radius * 5}
              opacity={0.9}
              spin={-model.milliseconds / 1200}
            />
          </group>
        )}
        <pointLight
          position={[0, 1.7, 0.4]}
          color={SIDES[index % 2]!}
          intensity={3}
          distance={7}
          decay={2}
        />
        <group position={[0, actor.standingHeight * 1.35, 0]}>
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
    </>
  );
}

/** Miniature figures chosen from recorded pose/state; the white capsule overlay stays the hitbox. */
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
