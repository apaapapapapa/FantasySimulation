export const OVERLAY_LABELS = {
  vision: '視野（定義上の範囲・角度と記録された向き）',
  collision: '当たり判定（白線）',
  paths: '軌跡（記録された折れ線）',
  hits: '命中点（記録座標）',
  rays: '射線（記録された区間）',
  motion: '押し出し・技の移動（記録された速度の0.1秒分）',
} as const;
export type Overlays = Record<keyof typeof OVERLAY_LABELS, boolean>;
export const NO_OVERLAYS: Overlays = {
  vision: false,
  collision: false,
  paths: false,
  hits: false,
  rays: false,
  motion: false,
};
export const ARROW_COLOURS = { force: '#ff9f5a', 'stage-motion': '#c9a6ff' } as const;
