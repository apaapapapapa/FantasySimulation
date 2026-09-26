import type { ActorDisplay } from '@fantasy/domain/spatial';

const locomotion = {
  idle: '停止',
  walk: '歩行',
  run: '走行',
  slow: '低速歩行（スタミナ枯渇）',
  flight: '飛行',
} as const;
const stageState = {
  preparing: '準備',
  active: '発動中',
  waiting: '段間の待機',
  complete: '完了',
  interrupted: '中断',
} as const;
const stageMotion = { dash: '突進', retreat: '後退', leap: '跳躍' } as const;
const reactionState = {
  applied: '発動',
  queued: '予約',
  released: '解放',
  cancelled: '取消',
} as const;

/** Readable text for the recorded #61 display fields; absent fields stay absent. */
export function motionSummary(actor: ActorDisplay, stageCount: number | null): string[] {
  const lines: string[] = [];
  if (actor.locomotion)
    lines.push(
      [
        locomotion[actor.locomotion.mode],
        ...(actor.locomotion.jumping ? ['ジャンプ中'] : []),
        ...(actor.locomotion.dodging ? ['回避中'] : []),
      ].join('・'),
    );
  const stage = actor.action?.stage;
  if (stage && actor.action) {
    const motion = stage.motion;
    lines.push(
      `技 ${actor.action.abilityId} 第${stage.contact.stageIndex + 1}段${stageCount ? `/全${stageCount}段` : ''} ${stageState[stage.state]}（${stage.shape}）` +
        (motion
          ? ` · ${stageMotion[motion.kind]} ${motion.speedMmPerSecond / 1000} m/s${motion.applied ? '' : '（移動は未適用）'}`
          : ''),
    );
  }
  if (actor.force?.active) {
    const { x, y, z } = actor.force.applied;
    lines.push(
      `押し出し ${Math.hypot(x, y, z).toFixed(1)} m/s（${actor.force.contributors.length}件${actor.force.capped ? '・上限で制限' : ''}）`,
    );
  }
  for (const reaction of actor.reactions ?? [])
    lines.push(`反応 ${reaction.abilityId} ${reactionState[reaction.state]}`);
  return lines.length ? lines : ['動作の記録なし'];
}
