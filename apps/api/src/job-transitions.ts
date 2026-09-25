import type { BattleResult } from '@fantasy/domain/spatial';
import type { simulationJobs } from './db/schema.ts';

type State = Pick<
  typeof simulationJobs.$inferSelect,
  'state' | 'attempts' | 'maxAttempts' | 'failureCode'
>;
export const canCancelJob = (job: Pick<State, 'state'>) =>
  job.state === 'queued' || job.state === 'running';
export const canRetryJob = (job: State, outcome: BattleResult['outcome']['kind'] | null) =>
  job.attempts < job.maxAttempts &&
  job.failureCode !== 'determinism-violation' &&
  !canCancelJob(job) &&
  outcome !== 'win' &&
  outcome !== 'draw';
