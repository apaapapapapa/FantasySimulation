import { Line } from '@react-three/drei';
import { Quaternion, Vector3 } from 'three';
import { visionRing, type SceneModel } from './scene-model.ts';
import { ARROW_COLOURS, type Overlays } from './overlays.ts';

function Sweep({ shape }: { shape: SceneModel['shapes'][number] }) {
  const start = new Vector3(...shape.points[0]),
    end = new Vector3(...shape.points[1]);
  const direction = end.clone().sub(start),
    length = direction.length();
  const position = start.add(end).multiplyScalar(0.5);
  const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize());
  return shape.radius ? (
    <mesh position={position} quaternion={rotation}>
      <capsuleGeometry args={[shape.radius, length, 4, 8]} />
      <meshBasicMaterial color="#e5f3ff" wireframe transparent opacity={0.45} depthTest={false} />
    </mesh>
  ) : (
    <Line points={shape.points} color="#e5f3ff" />
  );
}

function Vision({ actor }: { actor: SceneModel['actors'][number] }) {
  if (!actor.vision) return null;
  const { range, angle } = actor.vision;
  // This is the defined cone boundary; it does not claim visibility through terrain.
  const ring = visionRing(actor);
  return (
    <group position={actor.vision.position}>
      {angle >= Math.PI * 2 ? (
        <mesh>
          <sphereGeometry args={[range, 16, 8]} />
          <meshBasicMaterial color="#97d6ff" wireframe transparent opacity={0.12} />
        </mesh>
      ) : (
        <>
          <Line points={ring} color="#97d6ff" transparent opacity={0.35} />
          {[0, 12, 24, 36].map((i) => (
            <Line
              key={i}
              points={[[0, 0, 0], ring[i]!]}
              color="#97d6ff"
              transparent
              opacity={0.35}
            />
          ))}
        </>
      )}
    </group>
  );
}

export function SceneOverlays({ model, overlays }: { model: SceneModel; overlays: Overlays }) {
  return (
    <>
      {overlays.vision && model.actors.map((actor) => <Vision key={actor.id} actor={actor} />)}
      {overlays.collision && model.shapes.map((shape) => <Sweep key={shape.id} shape={shape} />)}
      {overlays.paths &&
        model.paths.map((p) => <Line key={p.id} points={p.points} color="#8addc0" lineWidth={2} />)}
      {overlays.rays &&
        model.rays.map((p) => <Line key={p.id} points={p.points} color="#f3e59b" lineWidth={3} />)}
      {overlays.motion &&
        model.arrows.map((a) => (
          <group key={a.id}>
            <Line points={a.points} color={ARROW_COLOURS[a.kind]} lineWidth={3} />
            <mesh position={a.points[1]}>
              <sphereGeometry args={[0.08, 10, 6]} />
              <meshBasicMaterial color={ARROW_COLOURS[a.kind]} />
            </mesh>
          </group>
        ))}
      {overlays.hits &&
        model.events.map((e) => (
          <mesh key={e.id} position={e.position}>
            <sphereGeometry args={[0.09, 12, 8]} />
            <meshBasicMaterial color="#f680b0" />
          </mesh>
        ))}
    </>
  );
}
