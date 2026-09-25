import { useEffect, useState } from 'react';
import {
  IdSchema,
  Vec3Schema,
  DEFAULT_BUDGET,
  JobRequestSchema,
  JobResponseSchema,
  JobStatusSchema,
  BattleResultResponseSchema,
  type Revision,
} from '@fantasy/domain/spatial';
import { api, errorText, reference } from '../api-client.ts';
import { facingToward, spawnPositions } from './spawn-position.ts';
import { recentIdentities, rememberIdentity } from './recent-identities.ts';

function required(items: Revision[], id: string) {
  const value = items.find((r) => r.id === id);
  if (!value) throw new Error('設定を選択してください');
  return value;
}

type Status = ReturnType<typeof JobStatusSchema.parse>;
type Result = ReturnType<typeof BattleResultResponseSchema.parse>;
import { loadRevisionCatalog } from './revision-catalog.ts';
export function useBattleJob(revisionTick: number) {
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
  const [history, setHistory] = useState(() => recentIdentities('jobs'));
  const [resumeId, setResumeId] = useState('');
  const [positionsText, setPositionsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void loadRevisionCatalog(controller.signal)
      .then(([characters, rulesets, scenarios]) => {
        if (controller.signal.aborted) return;
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
  function defaultPositions() {
    return spawnPositions(
      [required(catalog.characters, left), required(catalog.characters, right)],
      required(catalog.scenarios, scenario),
    );
  }
  function openJob(value: string) {
    const id = IdSchema.parse(value);
    setJobId(id);
    setResumeId(id);
    setStatus(null);
    setResult(null);
    setPollTick((n) => n + 1);
    setHistory((ids) => rememberIdentity('jobs', id, ids));
  }
  const active = status?.job.state === 'queued' || status?.job.state === 'running';
  const retryable = status?.job.allowedOperations?.retry === true;
  const cancellable = status?.job.allowedOperations?.cancel === true;
  async function submit() {
    const positions = positionsText.trim()
      ? Vec3Schema.array().length(2).parse(JSON.parse(positionsText))
      : defaultPositions();
    const request = JobRequestSchema.parse({
      spec: {
        seed,
        ruleset: reference(required(catalog.rulesets, ruleset)),
        scenario: reference(required(catalog.scenarios, scenario)),
        participants: [left, right].map((id, index) => ({
          actorId: index === 0 ? 'left' : 'right',
          character: reference(required(catalog.characters, id)),
          position: positions[index],
          facing: facingToward(positions[index]!, positions[1 - index]!),
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
    setHistory((ids) => rememberIdentity('jobs', submitted.job.id, ids));
  }
  async function cancel() {
    await api(`battle-jobs/${jobId}/cancel`, JobResponseSchema, { method: 'POST' });
    setPollTick((n) => n + 1);
  }
  async function retry() {
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
  }
  return {
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
  };
}
