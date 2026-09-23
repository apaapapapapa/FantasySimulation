import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import type { ReplayCheckpoint, ReplayContext } from '@fantasy/domain/spatial';

export type CameraMode = 'overview' | 'side' | 'follow' | 'free';
type Point = [number, number, number];
type Props = {
  context: ReplayContext;
  state: ReplayCheckpoint;
  cameraMode: CameraMode;
  overlays: boolean;
};
const position = (v: { x: number; y: number; z: number }): Point => [v.x, v.y, v.z];
const metres = (v: { x: number; y: number; z: number }): Point => [
  v.x / 1000,
  v.y / 1000,
  v.z / 1000,
];
const colours = {
  neutral: '#b5bfd1',
  red: '#e76669',
  blue: '#64a7e4',
  dark: '#545b78',
  bright: '#e8d89d',
  brown: '#ba895e',
  green: '#76bfa0',
};

function Camera({
  mode,
  span,
  follow,
  centre,
}: {
  mode: CameraMode;
  span: number;
  follow: Point;
  centre: Point;
}) {
  const { camera, gl } = useThree();
  const previous = useRef<CameraMode | null>(null);
  const [x, y, z] = follow;
  const [cx, cy, cz] = centre;
  useEffect(() => {
    if (mode === 'free' && previous.current === mode) return;
    const target: Point = mode === 'follow' ? [x, y, z] : [cx, cy, cz];
    if (mode === 'side') camera.position.set(cx + span, cy + span / 5, cz);
    else if (mode === 'follow') camera.position.set(x + 5, y + 3, z + 5);
    else camera.position.set(cx + span * 0.7, cy + span * 0.9, cz + span * 0.8);
    camera.lookAt(...target);
    camera.updateProjectionMatrix();
    previous.current = mode;
  }, [camera, mode, span, x, y, z, cx, cy, cz]);
  useFrame(() => {
    if (gl.info.render.calls > 0) gl.domElement.dataset.rendered = 'true';
  });
  return (
    <OrbitControls
      makeDefault
      enabled={mode === 'free'}
      target={mode === 'follow' ? follow : centre}
      enableDamping={false}
      minDistance={1}
      maxDistance={span * 4}
    />
  );
}

/** Every mesh comes from the saved manifest/state. Camera frames never advance combat. */
export default function Scene({ context, state, cameraMode, overlays }: Props) {
  const scenario = context.manifest.revisions.find(
    (r) =>
      r.kind === 'scenario' &&
      r.id === context.manifest.scenario.id &&
      r.revision === context.manifest.scenario.revision,
  );
  if (!scenario || scenario.kind !== 'scenario') throw new Error('Missing recorded arena');
  const arena = scenario.definition;
  const span =
    Math.max(
      ...(['x', 'y', 'z'] as const).map((axis) => arena.bounds.max[axis] - arena.bounds.min[axis]),
    ) / 1000;
  const centre: Point = [
    (arena.bounds.min.x + arena.bounds.max.x) / 2000,
    (arena.bounds.min.y + arena.bounds.max.y) / 2000,
    (arena.bounds.min.z + arena.bounds.max.z) / 2000,
  ];
  const follow = state.state?.actors[0]?.position ?? { x: 0, y: 0, z: 0 };
  const record = state.lastRecord;
  const events = record && 'events' in record ? record.events : [];
  return (
    <div className="replay-canvas">
      <Canvas
        camera={{ near: 0.05, far: 2000, position: [span, span, span] }}
        dpr={1}
        onCreated={({ gl }) => {
          gl.domElement.setAttribute('role', 'img');
          gl.domElement.setAttribute('aria-label', '保存ログの3D表示');
        }}
        fallback={<p>WebGLが利用できません。下の状態表とログで確認できます。</p>}
      >
        <color attach="background" args={['#0f1828']} />
        <ambientLight intensity={1.3} />
        <directionalLight position={[8, 20, 12]} intensity={2} />
        <Camera mode={cameraMode} span={span} follow={position(follow)} centre={centre} />
        {arena.obstacles.map((obstacle) => (
          <mesh
            key={obstacle.id}
            position={metres(obstacle.center)}
            rotation={
              obstacle.kind === 'box'
                ? [
                    0,
                    (obstacle.yawMilliDegrees * Math.PI) / 180000,
                    (obstacle.slopeMilliDegrees * Math.PI) / 180000,
                  ]
                : [0, 0, 0]
            }
          >
            {obstacle.kind === 'box' ? (
              <boxGeometry
                args={metres({
                  x: 2 * obstacle.halfExtents.x,
                  y: 2 * obstacle.halfExtents.y,
                  z: 2 * obstacle.halfExtents.z,
                })}
              />
            ) : (
              <cylinderGeometry
                args={[
                  obstacle.radiusMm / 1000,
                  obstacle.radiusMm / 1000,
                  (2 * obstacle.halfHeightMm) / 1000,
                  24,
                ]}
              />
            )}
            <meshStandardMaterial
              color={obstacle.blocks.movement ? '#526174' : '#364358'}
              roughness={0.9}
            />
          </mesh>
        ))}
        {state.state?.actors.map((actor, index) => {
          const definition = context.actors.find(
            (a) => a.participant.actorId === actor.id,
          )!.character;
          const radius = definition.body.radiusMm / 1000,
            length = definition.body.heightMm / 1000 - 2 * radius;
          const colour = definition.appearance
            ? colours[definition.appearance.surface]
            : index === 0
              ? '#d4b780'
              : '#68b7db';
          return (
            <group key={actor.id} position={position(actor.position)}>
              <mesh>
                <capsuleGeometry args={[radius, Math.max(0, length), 6, 16]} />
                <meshStandardMaterial color={colour} />
              </mesh>
              {overlays && (
                <>
                  <mesh scale={1.03}>
                    <capsuleGeometry args={[radius, Math.max(0, length), 6, 16]} />
                    <meshBasicMaterial color="#e5f3ff" wireframe />
                  </mesh>
                  <Line
                    points={[
                      [0, 0, 0],
                      [actor.facing.x, actor.facing.y, actor.facing.z],
                    ]}
                    color="#faf5d6"
                    lineWidth={2}
                  />
                </>
              )}
            </group>
          );
        })}
        {state.state?.projectiles.map((projectile) => (
          <mesh key={projectile.id} position={position(projectile.position)}>
            <sphereGeometry args={[projectile.radiusMm / 1000, 12, 8]} />
            <meshBasicMaterial color="#f0bd67" wireframe={overlays} />
          </mesh>
        ))}
        {overlays &&
          record?.kind === 'interval' &&
          record.paths.flatMap((path) =>
            path.segments.map((segment, i) => (
              <Line
                key={`${path.entityId}:${i}`}
                points={[position(segment.start), position(segment.end)]}
                color="#8addc0"
                lineWidth={2}
              />
            )),
          )}
        {overlays &&
          events
            .filter((e) => e.point)
            .map((event) => (
              <mesh key={event.id} position={position(event.point!)}>
                <sphereGeometry args={[0.09, 12, 8]} />
                <meshBasicMaterial color="#f680b0" />
              </mesh>
            ))}
      </Canvas>
    </div>
  );
}
