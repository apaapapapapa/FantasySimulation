import type { Revision } from '@fantasy/domain/spatial';
import { useBattleJob } from './useBattleJob.ts';
const stateNames = {
  queued: '待機中',
  running: '実行中',
  completed: '完了',
  failed: '失敗',
  cancelled: '中止済み',
};

export function BattlePanel({
  revisionTick,
  onReplay,
}: {
  revisionTick: number;
  onReplay(id: string): void;
}) {
  const {
    catalog,
    left,
    setLeft,
    right,
    setRight,
    ruleset,
    setRuleset,
    scenario,
    setScenario,
    seed,
    setSeed,
    maxBytes,
    setMaxBytes,
    jobId,
    status,
    result,
    history,
    resumeId,
    setResumeId,
    positionsText,
    setPositionsText,
    busy,
    error,
    work,
    defaultPositions,
    openJob,
    active,
    retryable,
    cancellable,
    submit,
    cancel,
    retry,
    setPollTick,
  } = useBattleJob(revisionTick);
  function options(items: Revision[]) {
    return items.map((r) => (
      <option key={r.id} value={r.id}>
        {r.definition.name} · r{r.revision} · {r.id}
      </option>
    ));
  }
  return (
    <section className="panel arena" aria-label="非同期対戦">
      <h2>対戦を実行</h2>
      <fieldset disabled={busy}>
        <div className="matchup">
          <label>
            参加者A
            <select value={left} onChange={(e) => setLeft(e.target.value)}>
              {options(catalog.characters)}
            </select>
          </label>
          <span>対</span>
          <label>
            参加者B
            <select value={right} onChange={(e) => setRight(e.target.value)}>
              {options(catalog.characters)}
            </select>
          </label>
        </div>
        <label>
          戦場
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {options(catalog.scenarios)}
          </select>
        </label>
        <label>
          ルール
          <select value={ruleset} onChange={(e) => setRuleset(e.target.value)}>
            {options(catalog.rulesets)}
          </select>
        </label>
        <label>
          乱数seed
          <input
            type="number"
            min="0"
            max="4294967295"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
          />
        </label>
        <details>
          <summary>計算予算</summary>
          <label>
            ログ上限bytes
            <input
              type="number"
              min="1"
              max="256000000"
              value={maxBytes}
              onChange={(e) => setMaxBytes(Number(e.target.value))}
            />
          </label>
          <p>上限で中断した場合は、予算を増やして明示的に再試行できます。</p>
        </details>
        <details>
          <summary>開始位置を調整</summary>
          <p>
            空欄は自動配置です。障害物に重なる場合は座標を調整してください。開始時に範囲と重なりを確認します。
          </p>
          <button
            type="button"
            onClick={() =>
              void work(async () => {
                setPositionsText(JSON.stringify(defaultPositions(), null, 2));
              })
            }
          >
            既定位置を入力
          </button>
          <label>
            開始位置JSON（A・Bの順、mm）
            <textarea value={positionsText} onChange={(e) => setPositionsText(e.target.value)} />
          </label>
          <details>
            <summary>選択した戦場の地形</summary>
            <pre>
              {JSON.stringify(
                catalog.scenarios.find((r) => r.id === scenario)?.definition,
                null,
                2,
              )}
            </pre>
          </details>
        </details>
        <button
          type="button"
          className="primary"
          disabled={!left || !right || !ruleset || !scenario || active}
          onClick={() =>
            void work(async () => {
              await submit();
            })
          }
        >
          対戦を開始
        </button>
        {jobId && (
          <div className="actions">
            <button
              type="button"
              disabled={!cancellable}
              onClick={() =>
                void work(async () => {
                  await cancel();
                })
              }
            >
              対戦を中止
            </button>
            <button
              type="button"
              disabled={!retryable}
              onClick={() =>
                void work(async () => {
                  await retry();
                })
              }
            >
              対戦を再試行
            </button>
            <button type="button" onClick={() => setPollTick((n) => n + 1)}>
              状態を再取得
            </button>
          </div>
        )}
      </fieldset>
      <p role="status" aria-label="対戦の状態">
        {status ? stateNames[status.job.state] : '未実行'}
      </p>
      {status && (
        <>
          <p>
            対戦ID <output aria-label="対戦ID">{status.job.id}</output>
          </p>
          <p>
            simulationHash <code>{status.job.simulationHash}</code>
          </p>
          <ol aria-label="試行履歴">
            {status.attempts.map((a) => (
              <li key={a.id}>
                試行 {a.number}: {a.state} / step{' '}
                <output aria-label={`試行${a.number}の進捗`}>{a.progressStep}</output>
                {a.error && <p>{a.error}</p>}
                {a.replayId && (
                  <button onClick={() => onReplay(a.replayId!)}>試行{a.number}の記録を見る</button>
                )}
              </li>
            ))}
          </ol>
          {status.job.error && <p role="alert">{status.job.error}</p>}
        </>
      )}
      {result && (
        <div className="result">
          <h3>対戦結果</h3>
          <p aria-label="結果の種類">{result.result.outcome.kind}</p>
          <p>記録済みstep: {result.result.steps}</p>
          {'reason' in result.result.outcome && <p>{result.result.outcome.reason}</p>}
          {result.result.outcome.kind === 'win' && <p>勝者: {result.result.outcome.winner}</p>}
          <button onClick={() => onReplay(result.replayId)}>結果のリプレイを見る</button>
          <details>
            <summary>保存結果の識別子</summary>
            <pre>{JSON.stringify(result.result, null, 2)}</pre>
          </details>
        </div>
      )}
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      <details>
        <summary>保存した対戦を開く</summary>
        <fieldset disabled={busy}>
          <label>
            開く対戦ID
            <input value={resumeId} onChange={(e) => setResumeId(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={!resumeId}
            onClick={() => void work(async () => openJob(resumeId))}
          >
            IDで開く
          </button>
          <ul aria-label="最近の対戦">
            {history.map((id) => (
              <li key={id}>
                <button type="button" onClick={() => openJob(id)}>
                  {id}
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      </details>
    </section>
  );
}
