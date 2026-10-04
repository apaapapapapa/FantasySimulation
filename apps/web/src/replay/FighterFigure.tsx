import { useEffect, useMemo } from 'react';
import { BoxGeometry, ConeGeometry, IcosahedronGeometry, MeshStandardMaterial } from 'three';
import type { Point, SceneModel } from './scene-model.ts';
import { spriteFade, spritePose, type Equipment, type SpritePose } from './pixel-sprites.ts';
import { tintColours } from './tint-colours.ts';

type Actor = SceneModel['actors'][number];
type Finish = 'cloth' | 'dark' | 'metal' | 'gold' | 'skin' | 'light';
type Materials = Record<Finish, MeshStandardMaterial>;
// Shared low-poly geometry; never allocate another mesh shape for a replay step.
const SHAPES = {
  box: new BoxGeometry(1, 1, 1),
  gem: new IcosahedronGeometry(0.5, 0),
  cone: new ConeGeometry(0.5, 1, 6),
};

/** Display pose only: world position, size and heading always come from the recorded actor. */
export function figurePresentation(actor: Actor, milliseconds: number) {
  const pose = spritePose(actor.pose, actor.subjectMilliseconds ?? milliseconds);
  const stride = pose === 'step-a' ? 0.55 : pose === 'step-b' ? -0.55 : 0;
  return {
    position: [actor.position[0], actor.feet, actor.position[2]] as Point,
    yaw: Math.atan2(-actor.facing[2], actor.facing[0]),
    scale: actor.standingHeight / 2,
    pose,
    stride,
    lowered: pose === 'crouch' || pose === 'dodge',
    fade: spriteFade(actor.phasing),
  };
}

function Part({
  at,
  size,
  material,
  shape = 'box',
  turn = 0,
}: {
  at: Point;
  size: Point;
  material: MeshStandardMaterial;
  shape?: keyof typeof SHAPES;
  turn?: number;
}) {
  return (
    <mesh
      position={at}
      scale={size}
      rotation={[0, 0, turn]}
      geometry={SHAPES[shape]}
      material={material}
      dispose={null}
      renderOrder={material.depthTest ? 0 : 5}
    />
  );
}

/** Every item is selected from saved appearance.equipment; names/abilities never add equipment. */
function HeldItem({ item, materials: m }: { item: Equipment; materials: Materials }) {
  return (
    <group name={`equipment:${item}`}>
      {item === 'shield' ? (
        <>
          <Part at={[0, 0, 0]} size={[0.14, 0.7, 0.6]} material={m.gold} shape="gem" />
          <Part at={[0.085, 0.015, 0]} size={[0.09, 0.52, 0.43]} material={m.cloth} shape="gem" />
          <Part at={[0.14, 0.02, 0]} size={[0.07, 0.19, 0.12]} material={m.light} shape="gem" />
        </>
      ) : item === 'grimoire' ? (
        <>
          <Part at={[0, 0, 0]} size={[0.35, 0.09, 0.44]} material={m.gold} />
          <Part at={[0, 0.05, 0]} size={[0.31, 0.05, 0.4]} material={m.skin} />
          <Part at={[0, 0.09, 0]} size={[0.025, 0.01, 0.4]} material={m.dark} />
        </>
      ) : item === 'bow' ? (
        <>
          {[-1, 1].map((side) => (
            <Part
              key={side}
              at={[0.09, side * 0.28, 0]}
              size={[0.06, 0.6, 0.06]}
              turn={side * -0.32}
              material={m.gold}
            />
          ))}
          <Part at={[0, 0, 0]} size={[0.012, 1.1, 0.012]} material={m.skin} />
        </>
      ) : (
        <>
          <Part
            at={[0, item === 'staff' || item === 'spear' ? 0.3 : 0.05, 0]}
            size={[0.065, item === 'staff' || item === 'spear' ? 1.6 : 0.48, 0.065]}
            material={m.dark}
          />
          {item === 'staff' ? (
            <>
              <Part at={[0, 1.11, 0]} size={[0.32, 0.42, 0.32]} material={m.gold} shape="gem" />
              <Part at={[0, 1.14, 0]} size={[0.22, 0.33, 0.22]} material={m.light} shape="gem" />
            </>
          ) : item === 'axe' ? (
            <Part at={[0.12, 0.5, 0]} size={[0.48, 0.42, 0.13]} material={m.metal} shape="gem" />
          ) : (
            <>
              <Part
                at={[0, item === 'spear' ? 1.16 : 0.53, 0]}
                size={[0.16, item === 'spear' ? 0.42 : 0.95, 0.075]}
                material={m.metal}
                shape="gem"
              />
              <Part
                at={[0, item === 'spear' ? 0.93 : 0.13, 0]}
                size={[0.32, 0.065, 0.1]}
                material={m.gold}
              />
            </>
          )}
        </>
      )}
    </group>
  );
}

function Humanoid({
  actor,
  pose,
  stride,
  materials: m,
}: {
  actor: Actor;
  pose: SpritePose;
  stride: number;
  materials: Materials;
}) {
  const equipment = actor.look.equipment;
  const robed = equipment.includes('staff') || equipment.includes('grimoire');
  const casting = pose === 'cast',
    attack = pose === 'attack';
  const armTurn = (side: number) => (casting ? 2.25 : attack ? 1.35 : side * stride * -0.7 + 0.15);
  return (
    <>
      <Part
        at={[-0.18, 1.04, 0]}
        size={[0.22, 1.35, 0.66]}
        turn={-0.15 - stride * 0.1}
        material={m.cloth}
        shape="cone"
      />
      {[-1, 1].map((side) => (
        <group
          key={side}
          position={[0, 0.87, side * 0.16]}
          rotation={[0, 0, side * stride + (pose === 'jump' ? side * 0.45 : 0)]}
        >
          <Part at={[0, -0.31, 0]} size={[0.18, 0.65, 0.2]} material={m.dark} />
          <Part at={[0.09, -0.73, 0]} size={[0.34, 0.17, 0.23]} material={m.metal} />
          <Part at={[0.08, -0.35, 0]} size={[0.09, 0.24, 0.21]} material={m.gold} shape="gem" />
        </group>
      ))}
      <Part
        at={[0, robed ? 0.85 : 1.19, 0]}
        size={robed ? [0.7, 1.25, 0.8] : [0.42, 0.65, 0.62]}
        material={m.cloth}
        shape={robed ? 'cone' : 'gem'}
      />
      <Part at={[0.14, 1.31, 0]} size={[0.19, 0.39, 0.47]} material={m.metal} shape="gem" />
      <Part at={[0, 1.03, 0]} size={[0.43, 0.08, 0.54]} material={m.gold} />
      <Part at={[0, 1.78, 0]} size={[0.4, 0.45, 0.42]} material={m.dark} shape="gem" />
      <Part at={[0.12, 1.77, 0]} size={[0.28, 0.3, 0.31]} material={m.skin} shape="gem" />
      <Part at={[0.15, 1.87, 0]} size={[0.15, 0.055, 0.38]} material={m.gold} />
      {robed && (
        <Part at={[-0.06, 1.98, 0]} size={[0.6, 0.25, 0.6]} material={m.cloth} shape="cone" />
      )}
      {[-1, 1].map((side) => (
        <group key={side} position={[0, 1.46, side * 0.36]} rotation={[0, 0, armTurn(side)]}>
          <Part at={[0, -0.05, 0]} size={[0.35, 0.34, 0.33]} material={m.metal} shape="gem" />
          <Part at={[0, -0.3, 0]} size={[0.17, 0.47, 0.18]} material={m.cloth} />
          <Part at={[0.02, -0.52, 0]} size={[0.22, 0.22, 0.22]} material={m.gold} shape="gem" />
          {equipment
            .filter((item) => (item === 'shield' || item === 'grimoire') === side < 0)
            .map((item, index) => (
              <group
                key={item}
                position={[0.1 + index * 0.08, -0.5, 0.02]}
                rotation={[0, 0, -armTurn(side) + (attack ? -1.1 : 0)]}
              >
                <HeldItem item={item} materials={m} />
              </group>
            ))}
        </group>
      ))}
      {actor.look.silhouette === 'winged' &&
        [-1, 1].map((side) => (
          <group
            key={side}
            position={[-0.13, 1.44, side * 0.2]}
            rotation={[side * (pose === 'fly-a' ? 0.45 : -0.25), 0, 0.25]}
          >
            {[0, 1, 2, 3].map((feather) => (
              <Part
                key={feather}
                at={[-0.15 - feather * 0.09, 0.06 - feather * 0.08, side * (0.32 + feather * 0.17)]}
                size={[0.17, 0.7 - feather * 0.08, 0.37]}
                material={feather % 2 ? m.skin : m.metal}
                shape="gem"
              />
            ))}
          </group>
        ))}
    </>
  );
}

function Creature({
  actor,
  stride,
  materials: m,
}: {
  actor: Actor;
  stride: number;
  materials: Materials;
}) {
  const beast = actor.look.silhouette === 'beast',
    construct = actor.look.silhouette === 'construct';
  return (
    <>
      <Part
        at={[0, beast ? 0.85 : 1, 0]}
        size={beast ? [1.25, 0.75, 0.55] : [1, 1.5, 0.85]}
        material={construct ? m.metal : m.cloth}
        shape="gem"
      />
      {beast ? (
        <>
          {[-1, 1].flatMap((end) =>
            [-1, 1].map((side) => (
              <group
                key={`${end}:${side}`}
                position={[end * 0.43, 0.79, side * 0.21]}
                rotation={[0, 0, end * side * stride]}
              >
                <Part at={[0, -0.31, 0]} size={[0.18, 0.64, 0.17]} material={m.dark} />
                <Part
                  at={[0.05, -0.68, 0]}
                  size={[0.28, 0.16, 0.23]}
                  material={m.gold}
                  shape="gem"
                />
              </group>
            )),
          )}
          <Part
            at={[-0.83, 0.98, 0]}
            size={[0.7, 0.25, 0.3]}
            turn={-0.4}
            material={m.cloth}
            shape="cone"
          />
          <Part at={[0.55, 1.25, 0]} size={[0.58, 0.62, 0.5]} material={m.cloth} shape="gem" />
          <Part at={[0.88, 1.17, 0]} size={[0.53, 0.28, 0.32]} material={m.dark} shape="gem" />
          {[-1, 1].map((side) => (
            <Part
              key={side}
              at={[0.49, 1.65, side * 0.18]}
              size={[0.2, 0.4, 0.19]}
              material={m.gold}
              shape="cone"
            />
          ))}
        </>
      ) : construct ? (
        <>
          {[-1, 1].map((side) => (
            <group key={side}>
              <Part at={[0, 0.22, side * 0.26]} size={[0.48, 0.42, 0.39]} material={m.dark} />
              <Part
                at={[0, 1.2, side * 0.58]}
                size={[0.43, 0.9, 0.43]}
                material={m.metal}
                shape="gem"
              />
            </group>
          ))}
          <Part at={[0, 1.76, 0]} size={[0.58, 0.48, 0.58]} material={m.gold} shape="gem" />
        </>
      ) : (
        <>
          <Part at={[0, 0.4, 0]} size={[1.2, 0.8, 1.2]} material={m.cloth} shape="gem" />
          <Part at={[0.1, 1.83, 0]} size={[0.2, 0.3, 0.2]} material={m.gold} shape="gem" />
        </>
      )}
      <Part
        at={[beast ? 0.78 : 0.45, beast ? 1.34 : 1.39, 0]}
        size={[0.13, 0.11, beast ? 0.4 : 0.31]}
        material={m.light}
      />
      {actor.look.equipment.map((item, index) => (
        <group key={item} position={[0.14, 0.9, 0.4 + index * 0.13]}>
          <HeldItem item={item} materials={m} />
        </group>
      ))}
    </>
  );
}

/** Faceted miniatures with recorded appearance, heading and discrete pose. No wall-clock motion. */
export function FighterFigure({
  actor,
  milliseconds,
  flash = false,
}: {
  actor: Actor;
  milliseconds: number;
  flash?: boolean;
}) {
  const presentation = figurePresentation(actor, milliseconds);
  const { pose, stride, fade } = presentation;
  const glow = tintColours(actor.signature ?? 'arcane').glow;
  const materials = useMemo(() => {
    const colours: Record<Finish, string> = {
      cloth: actor.colour,
      dark: '#182b30',
      metal: '#a8bdba',
      gold: '#d9bc83',
      skin: '#eadcc7',
      light: glow,
    };
    return Object.fromEntries(
      Object.entries(colours).map(([name, colour]) => [
        name,
        new MeshStandardMaterial({
          color: flash ? '#fff6df' : colour,
          flatShading: true,
          roughness: name === 'metal' || name === 'gold' ? 0.38 : 0.83,
          metalness: name === 'metal' || name === 'gold' ? 0.5 : 0.08,
          emissive: name === 'light' ? glow : '#000000',
          emissiveIntensity: name === 'light' ? 1.4 : 0,
          transparent: fade.opacity < 1,
          opacity: fade.opacity,
          depthWrite: fade.opacity === 1,
          depthTest: !fade.throughTerrain,
        }),
      ]),
    ) as Materials;
  }, [actor.colour, glow, flash, fade.opacity, fade.throughTerrain]);
  useEffect(() => () => Object.values(materials).forEach((value) => value.dispose()), [materials]);
  return (
    <group
      name={`fighter:${actor.id}`}
      position={presentation.position}
      rotation={[0, presentation.yaw, 0]}
      scale={presentation.scale}
      userData={{ actorId: actor.id, pose, silhouette: actor.look.silhouette }}
    >
      <group
        position={pose === 'down' ? [0.65, 0.45, 0] : [0, presentation.lowered ? -0.3 : 0, 0]}
        rotation={[0, 0, pose === 'down' ? Math.PI / 2 : presentation.lowered ? -0.3 : 0]}
      >
        {actor.look.silhouette === 'humanoid' || actor.look.silhouette === 'winged' ? (
          <Humanoid actor={actor} pose={pose} stride={stride} materials={materials} />
        ) : (
          <Creature actor={actor} stride={stride} materials={materials} />
        )}
      </group>
    </group>
  );
}
