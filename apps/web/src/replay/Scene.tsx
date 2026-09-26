import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import { Vector3 } from 'three';
import type { Point, SceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import type { Overlays } from './overlays.ts';
import { SceneOverlays } from './SceneOverlays.tsx';

export type CameraMode = 'overview' | 'side' | 'follow' | 'free';
/** One on-screen camera command (touch-friendly alternative to drag/pinch gestures). */
export interface CameraNudge {
  kind: 'left' | 'right' | 'in' | 'out';
  seq: number;
}
type Props = {
  model: SceneModel;
  cameraMode: CameraMode;
  overlays: Overlays;
  nudge?: CameraNudge | null;
};
const TURN = Math.PI / 12;

function Camera({
  mode,
  span,
  follow,
  centre,
  nudge,
}: {
  mode: CameraMode;
  span: number;
  follow: Point;
  centre: Point;
  nudge: CameraNudge | null | undefined;
}) {
  const { camera, gl, controls } = useThree();
  const previous = useRef<CameraMode | null>(null);
  const applied = useRef(nudge?.seq ?? 0);
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
  useEffect(() => {
    if (!nudge || nudge.seq === applied.current || mode !== 'free') return;
    applied.current = nudge.seq;
    const target = (controls as { target?: Vector3 } | null)?.target ?? new Vector3(...centre);
    const offset = camera.position.clone().sub(target);
    if (nudge.kind === 'left' || nudge.kind === 'right')
      offset.applyAxisAngle(new Vector3(0, 1, 0), nudge.kind === 'left' ? -TURN : TURN);
    else {
      const length = offset.length() * (nudge.kind === 'in' ? 0.75 : 1 / 0.75);
      offset.setLength(Math.min(span * 4, Math.max(1, length)));
    }
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
    (controls as { update?: () => void } | null)?.update?.();
  }, [camera, controls, nudge, mode, span, centre]);
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
export default function Scene({ model, cameraMode, overlays, nudge }: Props) {
  const { span, centre, follow } = model;
  return (
    // Touch gestures belong to the camera only in free mode; otherwise the page scrolls.
    <div className="replay-canvas" data-camera={cameraMode}>
      <Canvas
        camera={{ near: 0.05, far: 2000, position: [span, span, span] }}
        dpr={1}
        onCreated={({ gl }) => {
          gl.domElement.setAttribute('role', 'img');
          gl.domElement.setAttribute('aria-label', '保存ログの3D表示');
        }}
        fallback={
          <>
            <p>WebGLが利用できません。2D表示で保存ログを確認できます。</p>
            <Scene2D model={model} overlays={overlays} />
          </>
        }
      >
        <color attach="background" args={['#0f1828']} />
        <ambientLight intensity={1.3} />
        <directionalLight position={[8, 20, 12]} intensity={2} />
        <Camera mode={cameraMode} span={span} follow={follow} centre={centre} nudge={nudge} />
        {model.obstacles.map((o) => (
          <mesh
            key={o.id}
            position={o.position}
            rotation={o.kind === 'box' ? o.rotation : [0, 0, 0]}
          >
            {o.kind === 'box' ? (
              <boxGeometry args={o.size} />
            ) : (
              <cylinderGeometry args={[o.radius, o.radius, o.height, 24]} />
            )}
            <meshStandardMaterial color={o.colour} roughness={0.9} />
          </mesh>
        ))}
        {model.actors.map((a) => (
          <group key={a.id} position={a.position}>
            <mesh>
              <capsuleGeometry args={[a.radius, a.length, 6, 16]} />
              <meshStandardMaterial color={a.colour} />
            </mesh>
            {a.casting && (
              <mesh rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[a.radius * 1.5, 0.04, 6, 24]} />
                <meshBasicMaterial color="#b695ff" />
              </mesh>
            )}
            {overlays.collision && (
              <>
                <mesh>
                  <capsuleGeometry args={[a.radius, a.length, 6, 16]} />
                  <meshBasicMaterial color="#e5f3ff" wireframe depthTest={false} />
                </mesh>
                <Line points={[[0, 0, 0], a.facing]} color="#faf5d6" lineWidth={2} />
              </>
            )}
          </group>
        ))}
        {model.projectiles.map((p) => (
          <mesh key={p.id} position={p.position}>
            <sphereGeometry args={[p.radius, 12, 8]} />
            <meshBasicMaterial color="#f0bd67" wireframe={overlays.collision} />
          </mesh>
        ))}
        {model.effects.map((e) => (
          <mesh key={e.id} position={e.position}>
            <sphereGeometry args={[0.18, 8, 6]} />
            <meshBasicMaterial color={e.kind === 'hit' ? '#ff849e' : '#f7d77f'} wireframe />
          </mesh>
        ))}
        <SceneOverlays model={model} overlays={overlays} />
      </Canvas>
    </div>
  );
}
