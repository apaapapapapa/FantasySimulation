import { conceptMark } from './concept-mark.ts';
import { useId } from 'react';
import { prng } from './pixel-art.ts';
import { visionRing, type Point, type SceneModel } from './scene-model.ts';
import { ARROW_COLOURS, type Overlays } from './overlays.ts';

type Obstacle = SceneModel['obstacles'][number];
/** Top-view fills matching the 3D terrain: grassy generic blocks, stone, wood, metal, earth. */
const GROUND: Record<Obstacle['material'], string> = {
  generic: '#315a27',
  stone: '#626770',
  wood: '#7a5230',
  metal: '#6f7985',
  earth: '#6d5033',
};
const SIDES = ['#f6c26a', '#7cc8ff'] as const;
/** Seeded pixel tufts for a 4 m grass tile (display only). */
const TUFTS = (() => {
  const random = prng('map:grass'),
    fills = ['#264a20', '#3d6e2d', '#447a32', '#5b953d', '#f2d45c'];
  return Array.from({ length: 26 }, (_, i) => ({
    x: Math.round(random() * 15) / 4,
    y: Math.round(random() * 15) / 4,
    size: i % 9 === 8 ? 0.2 : 0.25,
    fill: fills[i % 9 === 8 ? 4 : Math.floor(random() * 4)]!,
  }));
})();
/** At zoom 1 the window frames the fighters with this margin (metres) around them. */
const MAP_MARGIN = 5;
const MAP_MINIMUM = 14;

/** Window side at zoom 1: the fighters and a margin, never below the minimum. */
function fighterSpan({ actors }: SceneModel) {
  const xs = actors.map((a) => a.position[0]),
    zs = actors.map((a) => a.position[2]);
  const spread = actors.length
    ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs))
    : Infinity;
  return Math.max(MAP_MINIMUM, spread + 2 * MAP_MARGIN);
}
const MAX_ZOOM = 8;

/**
 * One zoom button press. Zooming out stops once the whole recorded arena is in view, however
 * large it is; zooming in stops at a fixed magnification.
 */
export function zoomStep(model: SceneModel, zoom: number, kind: 'in' | 'out') {
  const arena = Math.max(model.max[0] - model.min[0], model.max[2] - model.min[2]);
  const minimum = Math.min(1, fighterSpan(model) / arena);
  return Math.min(MAX_ZOOM, Math.max(minimum, kind === 'in' ? zoom * 1.5 : zoom / 1.5));
}

/** Square top-view window around the fighters, zoomable and never larger than the arena. */
export function mapWindow(model: SceneModel, zoom: number, focus?: Point) {
  const { min, max, actors } = model;
  const base = fighterSpan(model) / zoom;
  const width = Math.min(max[0] - min[0], base),
    depth = Math.min(max[2] - min[2], base);
  const xs = actors.map((a) => a.position[0]),
    zs = actors.map((a) => a.position[2]);
  const centre = focus ?? [
    actors.length ? (Math.max(...xs) + Math.min(...xs)) / 2 : model.centre[0],
    0,
    actors.length ? (Math.max(...zs) + Math.min(...zs)) / 2 : model.centre[2],
  ];
  return {
    x: Math.min(max[0] - width, Math.max(min[0], centre[0]! - width / 2)),
    z: Math.min(max[2] - depth, Math.max(min[2], centre[2]! - depth / 2)),
    width,
    depth,
  };
}

/** Top view of the same geometry consumed by the Three renderer; no WebGL required. */
export function Scene2D({
  model,
  overlays,
  zoom = 1,
  focus,
}: {
  model: SceneModel;
  overlays: Overlays;
  /** Display magnification of the fighter-framed window around `focus` (below 1 zooms out). */
  zoom?: number;
  /** Window centre; defaults to the middle of the fighters. */
  focus?: Point | undefined;
}) {
  const { min, max } = model;
  const { x, z, width, depth } = mapWindow(model, zoom, focus);
  const id = useId().replace(/:/g, '');
  const outline = Math.max(0.04, width / 400);
  return (
    <svg
      role="img"
      aria-label="保存ログの2D表示"
      className="replay-canvas replay-map"
      data-zoom={zoom}
      viewBox={`${x} ${z} ${width} ${depth}`}
      shapeRendering="crispEdges"
    >
      <defs>
        <pattern id={`${id}-grass`} width={4} height={4} patternUnits="userSpaceOnUse">
          <rect width={4} height={4} fill={GROUND.generic} />
          {TUFTS.map((t) => (
            <rect
              key={`${t.x}:${t.y}`}
              x={t.x}
              y={t.y}
              width={t.size}
              height={t.size}
              fill={t.fill}
            />
          ))}
        </pattern>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" stopColor="#ffffff" stopOpacity={0.9} />
          <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </radialGradient>
      </defs>
      <rect
        x={min[0] - 1e4}
        y={min[2] - 1e4}
        width={max[0] - min[0] + 2e4}
        height={max[2] - min[2] + 2e4}
        fill="#070a0c"
      />
      <rect x={min[0]} y={min[2]} width={max[0] - min[0]} height={max[2] - min[2]} fill="#0f1828" />
      {model.obstacles.map((o) => {
        const fill = o.material === 'generic' ? `url(#${id}-grass)` : GROUND[o.material];
        const common = {
          fill,
          fillOpacity: o.solid ? 1 : 0.6,
          stroke: '#120d09',
          strokeWidth: outline,
        };
        return o.kind === 'cylinder' ? (
          <circle
            key={o.id}
            cx={o.position[0]}
            cy={o.position[2]}
            r={o.radius}
            {...common}
            fill={GROUND.stone}
          />
        ) : (
          <rect
            key={o.id}
            x={-o.topWidth / 2}
            y={-o.size[2] / 2}
            width={o.topWidth}
            height={o.size[2]}
            {...common}
            transform={`translate(${o.position[0]} ${o.position[2]}) rotate(${(-o.rotation[1] * 180) / Math.PI})`}
          />
        );
      })}
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
      {model.actors.map((a, index) => {
        const hp = a.hp && Math.max(0, Math.min(1, a.hp.value / Math.max(1, a.hp.max)));
        const label = Math.max(0.5, width / 60);
        return (
          <g key={a.id}>
            <ellipse
              cx={a.position[0] + 0.12}
              cy={a.position[2] + 0.12}
              rx={a.radius * 1.3}
              ry={a.radius * 1.1}
              fill="#000000"
              fillOpacity={0.4}
            />
            <circle
              cx={a.position[0]}
              cy={a.position[2]}
              r={a.radius * 1.45}
              fill="none"
              stroke={SIDES[index % 2]}
              strokeOpacity={0.8}
              strokeWidth={outline * 1.5}
            />
            {(a.sealing || a.revived || a.protected || a.defeated || a.frozen || a.evaded) && (
              <circle
                cx={a.position[0]}
                cy={a.position[2]}
                r={a.radius * 1.8}
                fill="none"
                stroke={conceptMark(a).colour}
                strokeWidth={0.05}
              >
                <title>{conceptMark(a).label}</title>
              </circle>
            )}
            <circle
              cx={a.position[0]}
              cy={a.position[2]}
              r={a.radius}
              fill={a.colour}
              fillOpacity={a.phasing ? 0.4 : 1}
              strokeDasharray={a.phasing?.pending ? '0.1 0.05' : undefined}
              stroke={overlays.collision ? '#e5f3ff' : '#120d09'}
              strokeWidth={overlays.collision ? 0.05 : outline}
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
            <g className="map-plate" aria-hidden="true" fontSize={label}>
              <text
                x={a.position[0]}
                y={a.position[2] - a.radius * 1.6 - label * 0.9}
                textAnchor="middle"
              >
                {a.name}
              </text>
              {hp !== null && (
                <>
                  <rect
                    x={a.position[0] - label * 1.6}
                    y={a.position[2] - a.radius * 1.6 - label * 0.6}
                    width={label * 3.2}
                    height={label * 0.3}
                    fill="#1a1210"
                    stroke="#8a6a3a"
                    strokeWidth={label * 0.06}
                  />
                  <rect
                    x={a.position[0] - label * 1.6}
                    y={a.position[2] - a.radius * 1.6 - label * 0.6}
                    width={label * 3.2 * hp}
                    height={label * 0.3}
                    fill="#c8383a"
                  />
                </>
              )}
            </g>
          </g>
        );
      })}
      {model.projectiles.map((p) => (
        <g key={p.id}>
          <circle
            cx={p.position[0]}
            cy={p.position[2]}
            r={Math.max(0.4, p.radius * 5)}
            fill={`url(#${id}-glow)`}
            opacity={0.55}
          />
          <circle
            cx={p.position[0]}
            cy={p.position[2]}
            r={p.radius}
            fill={p.colour}
            stroke={overlays.collision ? '#e5f3ff' : 'none'}
            strokeWidth={0.05}
          />
        </g>
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
