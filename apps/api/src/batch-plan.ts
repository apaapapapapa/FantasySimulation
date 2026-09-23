import { execFileSync } from 'node:child_process';
import {
  BatchInputSchema,
  BatchPlanBodySchema,
  BatchPlanSchema,
  ExecutionSourceSchema,
  CURRENT_ENGINE_VERSION,
  canonicalJson,
  compareIds,
  contentHash,
  parseJson,
  type BatchPlan,
  type ExecutionSource,
} from '@fantasy/domain/spatial';
import { implementation } from '@fantasy/engine/spatial';
import { openStore } from './store.ts';
import { repositoryRoot } from './config.ts';

export function executionSource(): ExecutionSource {
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 1_000_000,
    }).trim();
  if (git(['status', '--porcelain', '--untracked-files=normal']))
    throw new Error('Batch execution requires a clean committed source tree');
  return ExecutionSourceSchema.parse({
    sha: git(['rev-parse', 'HEAD']),
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  });
}
export async function createBatchPlan(input: unknown, source: ExecutionSource): Promise<BatchPlan> {
  const data = parseJson(BatchInputSchema, input),
    store = openStore(':memory:');
  try {
    if (data.matches.length * data.estimatedBytesPerMatch > data.maxOutputBytes)
      throw new Error('Planned storage estimate exceeds the declared batch limit; split the plan');
    if (data.matches.length * data.estimatedBytesPerMatch + 40 * 1024 ** 2 > data.maxWorkBytes)
      throw new Error('Planned storage estimate exceeds local work capacity; split the plan');
    if (new Set(data.matches.map((m) => m.key)).size !== data.matches.length)
      throw new Error('Duplicate planned match key');
    await store.loadPinnedRevisions(data.revisions);
    const slots: BatchPlan['slots'] = [];
    for (const match of data.matches) {
      const battle = await store.prepareSpec(match.spec);
      const identity = { key: match.key, simulationHash: battle.simulationHash };
      slots.push({ ...identity, id: await contentHash(identity), spec: match.spec });
    }
    if (new Set(slots.map((s) => s.simulationHash)).size !== slots.length)
      throw new Error(
        'Duplicate planned simulation; changing its label does not create another match',
      );
    const body = parseJson(BatchPlanBodySchema, {
      schemaVersion: 1,
      source,
      engineVersion: CURRENT_ENGINE_VERSION,
      implementationDigest: implementation.digest,
      revisions: data.revisions.sort((a, b) =>
        compareIds(`${a.kind}:${a.id}:${a.revision}`, `${b.kind}:${b.id}:${b.revision}`),
      ),
      slots: slots.sort((a, b) => compareIds(a.id, b.id)),
      budget: data.budget,
      estimatedBytesPerMatch: data.estimatedBytesPerMatch,
      maxOutputBytes: data.maxOutputBytes,
      maxWorkBytes: data.maxWorkBytes,
    });
    return { ...body, id: await contentHash(body) };
  } finally {
    store.close();
  }
}
export async function validateBatchPlan(input: unknown, source: ExecutionSource) {
  const plan = parseJson(BatchPlanSchema, input),
    { id, ...body } = plan;
  if (id !== (await contentHash(body))) throw new Error('Batch plan checksum mismatch');
  if (
    canonicalJson(plan.source) !== canonicalJson(source) ||
    plan.implementationDigest !== implementation.digest
  )
    throw new Error('Batch execution source does not match the pinned plan');
  const rebuilt = await createBatchPlan(
    {
      schemaVersion: 1,
      revisions: plan.revisions,
      matches: plan.slots.map(({ key, spec }) => ({ key, spec })),
      budget: plan.budget,
      estimatedBytesPerMatch: plan.estimatedBytesPerMatch,
      maxOutputBytes: plan.maxOutputBytes,
      maxWorkBytes: plan.maxWorkBytes,
    },
    source,
  );
  if (canonicalJson(plan) !== canonicalJson(rebuilt))
    throw new Error('Planned simulation/slot identity mismatch');
  return plan;
}
export { shardSlots } from './batch-check.ts';
