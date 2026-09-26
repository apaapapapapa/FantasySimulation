import { visionRing, type Point, type SceneModel } from './scene-model.ts';
import { ARROW_COLOURS, type Overlays } from './overlays.ts';

/** Top view of the same geometry consumed by the Three renderer; no WebGL required. */
export function Scene2D({
  model,
  overlays,
  zoom = 1,
  focus = model.centre,
}: {
  model: SceneModel;
  overlays: Overlays;
  /** Display magnification around `focus`, kept inside the recorded arena. */
  zoom?: number;
  focus?: Point;
}) {
  const { min, max } = model;
  const width = (max[0] - min[0]) / zoom,
    depth = (max[2] - min[2]) / zoom;
  const x = Math.min(max[0] - width, Math.max(min[0], focus[0] - width / 2)),
    z = Math.min(max[2] - depth, Math.max(min[2], focus[2] - depth / 2));
  return (
    <svg
      role="img"
      aria-label="保存ログの2D表示"
      className="replay-canvas"
      data-zoom={zoom}
      viewBox={`${x} ${z} ${width} ${depth}`}
    >
      <rect x={min[0]} y={min[2]} width={max[0] - min[0]} height={max[2] - min[2]} fill="#0f1828" />
      {model.obstacles.map((o) =>
        o.kind === 'cylinder' ? (
          <circle key={o.id} cx={o.position[0]} cy={o.position[2]} r={o.radius} fill={o.colour} />
        ) : (
          <rect
            key={o.id}
            x={-o.topWidth / 2}
            y={-o.size[2] / 2}
            width={o.topWidth}
            height={o.size[2]}
            fill={o.colour}
            transform={`translate(${o.position[0]} ${o.position[2]}) rotate(${(-o.rotation[1] * 180) / Math.PI})`}
          />
        ),
      )}
      {model.objects.map((o) => (
        <g key={o.id} fill={o.colour} fillOpacity={0.25} stroke={o.colour} strokeWidth={0.04}>
          <title>
            {o.kind === 'barrier'
              ? `結界 耐久 ${o.durability}`
              : o.kind === 'area'
                ? '持続範囲'
                : '照射'}
          </title>
          {o.shape?.kind === 'box' ? (
            <rect
              x={-o.shape.sizeMm.x / 2000}
              y={-o.shape.sizeMm.z / 2000}
              width={o.shape.sizeMm.x / 1000}
              height={o.shape.sizeMm.z / 1000}
              transform={`translate(${o.position[0]} ${o.position[2]}) rotate(${-o.shape.yawMilliDegrees / 1000})`}
            />
          ) : o.shape ? (
            <circle cx={o.position[0]} cy={o.position[2]} r={o.shape.radiusMm / 1000} />
          ) : null}
          {o.beams.map((b) => (
            <line
              key={b.id}
              x1={b.points[0][0]}
              y1={b.points[0][2]}
              x2={b.points[1][0]}
              y2={b.points[1][2]}
              strokeWidth={Math.max(0.03, b.radius * 2)}
              strokeLinecap="round"
            />
          ))}
        </g>
      ))}
      {model.actors.map((a) => (
        <g key={a.id}>
          <circle
            cx={a.position[0]}
            cy={a.position[2]}
            r={a.radius}
            fill={a.colour}
            fillOpacity={a.phasing ? 0.4 : 1}
            strokeDasharray={a.phasing?.pending ? '0.1 0.05' : undefined}
            stroke={overlays.collision ? '#e5f3ff' : 'none'}
            strokeWidth={0.05}
          >
            <title>{`${a.id}${a.phasing ? (a.phasing.pending ? ` 透過解除待ち ${a.phasing.intervals}/50` : ' 透過中') : ''}`}</title>
          </circle>
          {overlays.collision && (
            <line
              x1={a.position[0]}
              y1={a.position[2]}
              x2={a.position[0] + a.facing[0]}
              y2={a.position[2] + a.facing[2]}
              stroke="#faf5d6"
              strokeWidth={0.05}
            />
          )}
        </g>
      ))}
      {model.projectiles.map((p) => (
        <circle
          key={p.id}
          cx={p.position[0]}
          cy={p.position[2]}
          r={p.radius}
          fill={p.colour}
          stroke={overlays.collision ? '#e5f3ff' : 'none'}
          strokeWidth={0.05}
        />
      ))}
      {overlays.vision &&
        model.actors
          .filter((a) => a.vision)
          .map((a) => (
            <g
              key={a.id}
              transform={`translate(${a.vision!.position[0]} ${a.vision!.position[2]})`}
              fill="none"
              stroke="#97d6ff"
              strokeWidth={0.05}
              opacity={0.5}
            >
              {a.vision!.angle >= Math.PI * 2 ? (
                <circle r={a.vision!.range} />
              ) : (
                <>
                  <polyline
                    points={visionRing(a)
                      .map((p) => `${p[0]},${p[2]}`)
                      .join(' ')}
                  />
                  {[0, 12, 24, 36].map((i) => {
                    const p = visionRing(a)[i]!;
                    return <line key={i} x1={0} y1={0} x2={p[0]} y2={p[2]} />;
                  })}
                </>
              )}
            </g>
          ))}
      {overlays.collision &&
        model.shapes.map((s) => (
          <line
            key={s.id}
            x1={s.points[0][0]}
            y1={s.points[0][2]}
            x2={s.points[1][0]}
            y2={s.points[1][2]}
            stroke="#e5f3ff"
            opacity={0.45}
            strokeLinecap="round"
            strokeWidth={Math.max(0.02, s.radius * 2)}
          />
        ))}
      {overlays.rays &&
        model.rays.map((r) => (
          <line
            key={r.id}
            x1={r.points[0][0]}
            y1={r.points[0][2]}
            x2={r.points[1][0]}
            y2={r.points[1][2]}
            stroke="#f3e59b"
            strokeWidth={0.06}
          />
        ))}
      {overlays.paths &&
        model.paths.map((p) => (
          <line
            key={p.id}
            x1={p.points[0][0]}
            y1={p.points[0][2]}
            x2={p.points[1][0]}
            y2={p.points[1][2]}
            stroke="#8addc0"
            strokeWidth={0.05}
          />
        ))}
      {overlays.motion &&
        model.arrows.map((a) => (
          <g key={a.id} stroke={ARROW_COLOURS[a.kind]} fill={ARROW_COLOURS[a.kind]}>
            <line
              x1={a.points[0][0]}
              y1={a.points[0][2]}
              x2={a.points[1][0]}
              y2={a.points[1][2]}
              strokeWidth={0.07}
            />
            <circle cx={a.points[1][0]} cy={a.points[1][2]} r={0.1} />
          </g>
        ))}
      {overlays.hits &&
        model.events.map((e) => (
          <circle key={e.id} cx={e.position[0]} cy={e.position[2]} r={0.09} fill="#f680b0" />
        ))}
    </svg>
  );
}
