import { useEffect, useState } from 'react';
import {
  actorSeed,
  CURRENT_ENGINE_VERSION,
  DEFAULT_BUDGET,
  JobRequestSchema,
  JobResponseSchema,
  JobStatusSchema,
  BattleResultResponseSchema,
  RevisionPageSchema,
  type Revision,
} from '@fantasy/domain/spatial';
import { api, errorText, reference } from '../api-client.ts';
import { spawnPosition } from './spawn-position.ts';

type Status = ReturnType<typeof JobStatusSchema.parse>;
type Result = ReturnType<typeof BattleResultResponseSchema.parse>;
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
  const [catalog, setCatalog] = useState<{
    characters: Revision[];
    rulesets: Revision[];
    scenarios: Revision[];
  }>({ characters: [], rulesets: [], scenarios: [] });
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [ruleset, setRuleset] = useState('');
  const [scenario, setScenario] = useState('');
  const [seed, setSeed] = useState(42);
  const [maxBytes, setMaxBytes] = useState(DEFAULT_BUDGET.maxBytes);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function pages(kind: string) {
      const items: Revision[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        if (cursor) {
          if (seen.has(cursor) || seen.size >= 10)
            throw new Error('設定一覧のページ参照が不正です');
          seen.add(cursor);
        }
        const page: ReturnType<typeof RevisionPageSchema.parse> = await api(
          `revisions/${kind}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          RevisionPageSchema,
          { signal: controller.signal },
        );
        items.push(...page.items);
        cursor = page.nextCursor;
        if (items.length >= 1000 && cursor)
          throw new Error('設定が多すぎます。1000件以内のローカルDBを使用してください。');
      } while (cursor);
      return items;
    }
    void Promise.all([pages('character'), pages('ruleset'), pages('scenario')])
      .then(([characters, allRules, scenarios]) => {
        if (controller.signal.aborted) return;
        const rulesets = allRules.filter(
          (r) => r.kind === 'ruleset' && r.definition.rulesVersion === CURRENT_ENGINE_VERSION,
        );
        setCatalog({ characters, rulesets, scenarios });
        setLeft((old) => old || characters[0]?.id || '');
        setRight((old) => old || characters[1]?.id || '');
        setRuleset((old) => (rulesets.some((r) => r.id === old) ? old : rulesets[0]?.id || ''));
        setScenario((old) => old || scenarios[0]?.id || '');
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [revisionTick]);
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setResult(null);
    setError('');
    async function poll() {
      try {
        const next = await api(`battle-jobs/${jobId}`, JobStatusSchema, {
          signal: controller.signal,
        });
        if (next.job.id !== jobId) throw new Error('要求した対戦IDと応答が一致しません');
        if (controller.signal.aborted) return;
        setStatus(next);
        if (next.job.resultId) {
          const saved = await api(
            `battle-results/${next.job.resultId}`,
            BattleResultResponseSchema,
            { signal: controller.signal },
          );
          if (
            saved.id !== next.job.resultId ||
            saved.result.simulationHash !== next.job.simulationHash
          )
            throw new Error('対戦と結果のIDが一致しません');
          if (!controller.signal.aborted) setResult(saved);
        }
        if (next.job.state === 'queued' || next.job.state === 'running')
          timer = setTimeout(() => void poll(), 250);
      } catch (e) {
        if (!controller.signal.aborted) setError(errorText(e));
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [jobId, pollTick]);
  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function options(items: Revision[]) {
    return items.map((r) => (
      <option key={r.id} value={r.id}>
        {r.definition.name} · r{r.revision} · {r.id}
      </option>
    ));
  }
  const active = status?.job.state === 'queued' || status?.job.state === 'running';
  const retryable =
    status &&
    !active &&
    status.job.attempts < status.job.maxAttempts &&
    (status.job.state !== 'completed' ||
      result?.result.outcome.kind === 'truncated' ||
      result?.result.outcome.kind === 'unresolved');
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
        <button
          type="button"
          className="primary"
          disabled={!left || !right || !ruleset || !scenario || active}
          onClick={() =>
            void work(async () => {
              const required = (items: Revision[], id: string) => {
                const value = items.find((r) => r.id === id);
                if (!value) throw new Error('設定を選択してください');
                return value;
              };
              const request = JobRequestSchema.parse({
                spec: {
                  seed,
                  ruleset: reference(required(catalog.rulesets, ruleset)),
                  scenario: reference(required(catalog.scenarios, scenario)),
                  participants: [left, right].map((id, index) => ({
                    actorId: index === 0 ? 'left' : 'right',
                    character: reference(required(catalog.characters, id)),
                    position: spawnPosition(
                      required(catalog.characters, id),
                      required(catalog.scenarios, scenario),
                      index,
                    ),
                    facing: { x: index === 0 ? 1000 : -1000, y: 0, z: 0 },
                    rngSeed: actorSeed(seed, index as 0 | 1),
                    rngStream: index,
                  })),
                },
                budget: { ...DEFAULT_BUDGET, maxBytes },
              });
              const submitted = await api('battle-jobs', JobResponseSchema, {
                method: 'POST',
                body: request,
                headers: { 'x-client-id': 'local-web', 'idempotency-key': crypto.randomUUID() },
              });
              setResult(null);
              setStatus({ job: submitted.job, attempts: [] });
              setJobId(submitted.job.id);
              setPollTick((n) => n + 1);
              setHistory((ids) =>
                [submitted.job.id, ...ids.filter((id) => id !== submitted.job.id)].slice(0, 20),
              );
            })
          }
        >
          対戦を開始
        </button>
        {jobId && (
          <div className="actions">
            <button
              type="button"
              disabled={!active}
              onClick={() =>
                void work(async () => {
                  await api(`battle-jobs/${jobId}/cancel`, JobResponseSchema, { method: 'POST' });
                  setPollTick((n) => n + 1);
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
                  const next = await api(`battle-jobs/${jobId}/retry`, JobResponseSchema, {
                    method: 'POST',
                    body: {
                      expectedAttempts: status!.job.attempts,
                      budget: { ...DEFAULT_BUDGET, maxBytes },
                    },
                  });
                  setStatus({ job: next.job, attempts: [] });
                  setResult(null);
                  setPollTick((n) => n + 1);
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
      {history.length > 0 && (
        <details>
          <summary>この画面で実行した対戦</summary>
          <ul>
            {history.map((id) => (
              <li key={id}>
                <button
                  onClick={() => {
                    setJobId(id);
                    setStatus(null);
                    setPollTick((n) => n + 1);
                  }}
                >
                  {id}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
