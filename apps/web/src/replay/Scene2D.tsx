import type { SceneModel } from './scene-model.ts';
import type { Overlays } from './overlays.ts';

/** Top view of the same geometry consumed by the Three renderer; no WebGL required. */
export function Scene2D({ model, overlays }: { model: SceneModel; overlays: Overlays }) {
  const { min, max } = model;
  return (
    <svg
      role="img"
      aria-label="保存ログの2D表示"
      className="replay-canvas"
      viewBox={`${min[0]} ${min[2]} ${max[0] - min[0]} ${max[2] - min[2]}`}
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
      {model.actors.map((a) => (
        <g key={a.id}>
          <circle cx={a.position[0]} cy={a.position[2]} r={a.radius} fill={a.colour}>
            <title>{a.id}</title>
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
        <circle key={p.id} cx={p.position[0]} cy={p.position[2]} r={p.radius} fill="#f0bd67" />
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
      {overlays.hits &&
        model.events.map((e) => (
          <circle key={e.id} cx={e.position[0]} cy={e.position[2]} r={0.09} fill="#f680b0" />
        ))}
    </svg>
  );
}
