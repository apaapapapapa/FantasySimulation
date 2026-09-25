import { RECORDING_PROFILE, type PublicMatchRow } from '@fantasy/domain/spatial';

export const playbackLabels = {
  full: '全記録を再生できます',
  partial: '記録済みの範囲だけ再生できます',
  unavailable: '再生できません',
} satisfies Record<PublicMatchRow['playback'], string>;

export const cancellationReason = '実行がキャンセルされ、再生できる記録がありません';

export const reasonLabels = {
  'verified-result': '結果と保存記録を確認済み',
  'recorded-unresolved': 'ルール未確定のため終了',
  'recorded-truncated': '計算予算の上限で打ち切り',
  'execution-failed': '実行に失敗し、再生できる記録がありません',
  'not-started': 'まだ実行されていません',
  'missing-shard': 'この枠のバッチ結果がまだ届いていません',
} satisfies Record<PublicMatchRow['reason'], string>;

export function matchResult(row: PublicMatchRow) {
  const outcome = row.result?.outcome;
  if (!outcome) return '未確定';
  if (outcome.kind === 'win') {
    const winner = row.participants.find((p) => p.actorId === outcome.winner)!;
    return `勝者: ${winner.character.name} (${winner.actorId})`;
  }
  return { draw: '引き分け', unresolved: '未確定', truncated: '打ち切り・勝敗未確定' }[
    outcome.kind
  ];
}

export function matchDuration(row: PublicMatchRow) {
  return row.result
    ? `${row.result.steps} step / ${((row.result.steps * RECORDING_PROFILE.stepMs) / 1000).toFixed(2)}秒`
    : '終了stepなし';
}
