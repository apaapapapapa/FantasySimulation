import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import { Fog, Vector3 } from 'three';
import type { Point, SceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import type { Overlays } from './overlays.ts';
import { SceneOverlays } from './SceneOverlays.tsx';
import { frameCamera, FOV_DEGREES } from './camera-frame.ts';
import { SceneTerrain } from './SceneTerrain.tsx';
import { SceneFighters } from './SceneFighters.tsx';
import { SceneEffects } from './SceneEffects.tsx';

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
/** Drawing-buffer rows; the browser upscales them with nearest-neighbour for a dot-art look. */
const PIXEL_ROWS = 240;

/**
 * Pixel ratio giving about PIXEL_ROWS drawing-buffer rows, with a whole number of device pixels
 * per buffer pixel so every dot is the same size. It is passed as the Canvas `dpr` prop, which
 * R3F re-applies on every render.
 */
function usePixelRatio(stage: RefObject<HTMLDivElement | null>) {
  const [height, setHeight] = useState(PIXEL_ROWS * 2);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [stage]);
  const device = window.devicePixelRatio || 1;
  return device / Math.max(1, Math.round((height * device) / PIXEL_ROWS));
}

/** Fog starts just beyond what the camera looks at, so the far floor edge fades into the night. */
function DepthFog() {
  const fog = useRef<Fog>(null);
  useFrame(({ camera, controls }) => {
    const target = (controls as { target?: Vector3 } | null)?.target;
    const distance = target ? camera.position.distanceTo(target) : 30;
    const value = fog.current;
    if (!value) return;
    value.near = distance * 1.1;
    value.far = distance * 2.6;
  });
  return <fog ref={fog} attach="fog" args={['#0a0f10', 30, 90]} />;
}

function Camera({
  mode,
  model,
  nudge,
}: {
  mode: CameraMode;
  model: SceneModel;
  nudge: CameraNudge | null | undefined;
}) {
  const { camera, gl, controls, size } = useThree();
  const aspect = size.width / Math.max(1, size.height);
  const framing = useMemo(
    () => (mode === 'free' ? null : frameCamera(mode, model.actors, aspect)),
    [mode, model.actors, aspect],
  );
  // Free mode keeps the last framed target, so the user orbits what was on screen.
  const [anchor, setAnchor] = useState<Point>(model.centre);
  if (framing && framing.target !== anchor) setAnchor(framing.target);
  const applied = useRef(nudge?.seq ?? 0);
  useEffect(() => {
    if (!framing) return;
    camera.position.set(...framing.position);
    camera.lookAt(...framing.target);
    camera.updateProjectionMatrix();
  }, [camera, framing]);
  useEffect(() => {
    if (!nudge || nudge.seq === applied.current || mode !== 'free') return;
    applied.current = nudge.seq;
    const target = (controls as { target?: Vector3 } | null)?.target ?? new Vector3(...anchor);
    const offset = camera.position.clone().sub(target);
    if (nudge.kind === 'left' || nudge.kind === 'right')
      offset.applyAxisAngle(new Vector3(0, 1, 0), nudge.kind === 'left' ? -TURN : TURN);
    else {
      const length = offset.length() * (nudge.kind === 'in' ? 0.75 : 1 / 0.75);
      offset.setLength(Math.min(model.span * 4, Math.max(1, length)));
    }
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
    (controls as { update?: () => void } | null)?.update?.();
  }, [camera, controls, nudge, mode, model.span, anchor]);
  useFrame(() => {
    if (gl.info.render.calls > 0) gl.domElement.dataset.rendered = 'true';
  });
  return (
    <OrbitControls
      makeDefault
      enabled={mode === 'free'}
      target={framing?.target ?? anchor}
      enableDamping={false}
      minDistance={1}
      maxDistance={model.span * 4}
    />
  );
}

/**
 * Every mesh comes from the saved manifest/state; camera frames never advance combat.
 * The look (pixel scale, sprites, glows, lights) is presentation only.
 */
export default function Scene({ model, cameraMode, overlays, nudge }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const dpr = usePixelRatio(stage);
  return (
    // Touch gestures belong to the camera only in free mode; otherwise the page scrolls.
    <div ref={stage} className="replay-canvas replay-stage" data-camera={cameraMode}>
      <Canvas
        flat
        dpr={dpr}
        camera={{
          fov: FOV_DEGREES,
          near: 0.05,
          far: 2000,
          position: [model.span, model.span, model.span],
        }}
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
        <color attach="background" args={['#070a0c']} />
        <DepthFog />
        <ambientLight color="#4b5b7c" intensity={1.25} />
        <hemisphereLight args={['#9fb6e6', '#3a2a18', 1.1]} />
        <directionalLight position={[-7, 16, 10]} color="#dfe8ff" intensity={1.3} />
        <Camera mode={cameraMode} model={model} nudge={nudge} />
        <SceneTerrain model={model} />
        <SceneFighters model={model} portal={stage as RefObject<HTMLElement>} />
        <SceneEffects model={model} />
        {overlays.collision && (
          <>
            {model.actors.map((a) => (
              <group key={a.id} position={a.position}>
                <mesh>
                  <capsuleGeometry args={[a.radius, a.length, 6, 16]} />
                  <meshBasicMaterial color="#e5f3ff" wireframe depthTest={false} />
                </mesh>
                <Line points={[[0, 0, 0], a.facing]} color="#faf5d6" lineWidth={2} />
              </group>
            ))}
            {model.projectiles.map((p) => (
              <mesh key={p.id} position={p.position}>
                <sphereGeometry args={[p.radius, 12, 8]} />
                <meshBasicMaterial color="#e5f3ff" wireframe depthTest={false} />
              </mesh>
            ))}
            {model.dependents.map((dependent) => (
              <mesh key={dependent.id} position={dependent.position}>
                <capsuleGeometry args={[dependent.radius, dependent.length, 4, 10]} />
                <meshBasicMaterial color="#f4dd9b" wireframe depthTest={false} />
              </mesh>
            ))}
          </>
        )}
        <SceneOverlays model={model} overlays={overlays} />
      </Canvas>
    </div>
  );
}
