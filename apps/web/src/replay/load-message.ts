import { errorText } from '../api-client.ts';
import { ReplayLoadError } from './artifacts.ts';

export function replayErrorText(error: unknown) {
  if (!(error instanceof ReplayLoadError)) return errorText(error);
  const labels = {
    limit: '配信の上限に達しました。時間をおいて再度お試しください',
    gone: 'この公開データは見つかりません。公開終了または未公開の可能性があります',
    damaged: '公開データの破損または不整合を検出しました',
    unsupported: 'この画面では対応していない記録形式です',
    unavailable: 'データを取得できません。通信状態や配信サービスを確認してください',
    aborted: '読込を中止しました',
  };
  return `${labels[error.kind]} (${error.message})`;
}
