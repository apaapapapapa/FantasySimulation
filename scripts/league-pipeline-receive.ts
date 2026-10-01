import { join } from 'node:path';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import {
  canonicalJson,
  PublicKeySchema,
  LeaguePipelineControlSchema,
  LeagueProducerTerminalSchema,
} from '@fantasy/domain/spatial';
import {
  cloudInput,
  cloudJson,
  preparedLeague,
} from '../apps/cli/src/league/league-cloud-files.ts';
import {
  assignLeagueRunners,
  requireLeagueAssignment,
} from '../apps/cli/src/league/league-assignment.ts';
import { preparedLeagueCosts } from '../apps/cli/src/league/league-cost-profile.ts';
import {
  authenticateLeagueProducer,
  type LeagueProducer,
} from '../apps/cli/src/league/league-producer.ts';
import { PublicationEvidence } from '../apps/cli/src/publication/publication-evidence.ts';
import { decodeLeagueCheckpoint } from '../apps/cli/src/league/league-checkpoint.ts';
import { publicationInventory } from '../apps/cli/src/publication/publication-files.ts';
import type { LeagueStaging } from '../apps/cli/src/league/league-staging.ts';
import { PipelineArtifacts, type PipelineArtifact } from './league-pipeline-artifacts.ts';
import { pipelineInputKey } from './league-pipeline-compute.ts';
import { pipelineCapacity, pipelinePollMs } from './league-pipeline-policy.ts';

export async function receiveBaseline(root: string, github: PipelineArtifacts, maxAgeMs: number) {
  const prefix = `league-${github.identity.runId}-${github.identity.runAttempt}`;
  const all = await github.list(),
    ref = all.find((a) => a.name === prefix + '-baseline');
  if (!ref) throw new Error('Missing authenticated baseline');
  const preparedRoot = join(root, 'baseline');
  await github.download(
    ref,
    preparedRoot,
    (key) => key === 'checkpoint.gz' || (pipelineInputKey(key) && !key.includes('/retained/')),
  );
  const control = LeaguePipelineControlSchema.parse(
    await cloudJson(join(preparedRoot, 'control.json')),
  );
  if (canonicalJson(control.identity) !== canonicalJson(github.identity))
    throw new Error('Baseline execution mismatch');
  const baseline = await PublicationEvidence.restore(
    decodeLeagueCheckpoint(await readFile(join(preparedRoot, 'checkpoint.gz'))),
    {
      catalogHash: control.catalogHash,
      validatorDigest: github.identity.validatorDigest,
      now: Date.now(),
      maxAgeMs,
      authenticate: async (checkpoint) => {
        if (canonicalJson(checkpoint.identity) !== canonicalJson(github.identity))
          throw new Error('Baseline checkpoint identity mismatch');
      },
    },
  );
  return { control, baseline, preparedRoot };
}

const partPattern = /-runner-(\d+)-partition-(\d+)-part-([0-2])-of-([1-3])$/;
async function assemblePartition(
  root: string,
  github: PipelineArtifacts,
  parts: PipelineArtifact[],
) {
  const assembled = join(root, 'assembled');
  await mkdir(assembled);
  let proof: Buffer | undefined, result: Buffer | undefined;
  const keys = new Set<string>();
  for (const [i, ref] of parts.entries()) {
    const part = join(root, 'part-' + i);
    await github.download(
      ref,
      part,
      (key) =>
        ['proof.json', 'result.json'].includes(key) ||
        (key.startsWith('public/') && PublicKeySchema.safeParse(key.slice(7)).success),
    );
    const incomingProof = await readFile(join(part, 'proof.json')),
      incomingResult = await readFile(join(part, 'result.json'));
    if (proof && (!proof.equals(incomingProof) || !result!.equals(incomingResult)))
      throw new Error('Multipart producer metadata changed');
    proof = incomingProof;
    result = incomingResult;
    for (const key of (await publicationInventory(join(part, 'public'))).keys()) {
      if (keys.has(key)) throw new Error('Duplicate multipart publication path');
      keys.add(key);
    }
    await cp(join(part, 'public'), join(assembled, 'public'), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await rm(part, { recursive: true });
  }
  await writeFile(join(assembled, 'proof.json'), proof!, { flag: 'wx' });
  await writeFile(join(assembled, 'result.json'), result!, { flag: 'wx' });
  return assembled;
}

/** One assembled partition at a time. Success requires exact terminal references AND finished jobs. */
export async function receivePipeline(
  root: string,
  preparedRoot: string,
  github: PipelineArtifacts,
  runners: number,
  staging: LeagueStaging,
  signal: AbortSignal,
) {
  const prepared = await preparedLeague(preparedRoot);
  const assignments = assignLeagueRunners(
    prepared.plan,
    runners,
    await preparedLeagueCosts(preparedRoot, prepared, true),
  );
  return receiveAssignedPipeline(root, preparedRoot, github, runners, staging, signal, assignments);
}

/** Diagnostic only: original-input binding is checked before any artifact receive. */
export async function receivePartitionPilot(
  root: string,
  preparedRoot: string,
  github: PipelineArtifacts,
  runners: number,
  staging: LeagueStaging,
  signal: AbortSignal,
  originalInputs: (preparedRoot: string) => Promise<void>,
) {
  await originalInputs(preparedRoot);
  const prepared = await preparedLeague(preparedRoot);
  if (
    ![1, 2].includes(runners) ||
    prepared.inputs.length !== 3 ||
    prepared.plan.partitions.length !== 3 ||
    prepared.plan.partitions.reduce((n, p) => n + p.slots, 0) !== 380
  )
    throw new Error('Partition pilot scope mismatch');
  const assignments = requireLeagueAssignment(
    prepared.plan,
    assignLeagueRunners(prepared.plan, runners),
    runners,
  );
  return receiveAssignedPipeline(root, preparedRoot, github, runners, staging, signal, assignments);
}

async function receiveAssignedPipeline(
  root: string,
  preparedRoot: string,
  github: PipelineArtifacts,
  runners: number,
  staging: LeagueStaging,
  signal: AbortSignal,
  assignments: ReturnType<typeof assignLeagueRunners>,
) {
  const started = performance.now(),
    prefix = `league-${github.identity.runId}-${github.identity.runAttempt}`;
  const prepared = await preparedLeague(preparedRoot);
  const coverage = assignments.flatMap((a) => a.partitions);
  if (
    assignments.length !== runners ||
    assignments.some((a, i) => a.runner !== i) ||
    coverage.length !== prepared.inputs.length ||
    new Set(coverage).size !== coverage.length ||
    coverage.some((p) => !Number.isInteger(p) || p < 0 || p >= prepared.inputs.length)
  )
    throw new Error('Incomplete receiver assignment coverage');
  pipelineCapacity(prepared.inputs.length, assignments);
  const producers: LeagueProducer[] = [],
    completed = new Set<number>(),
    adopted = new Map<number, PipelineArtifact>();
  const terminals = new Map<number, ReturnType<typeof LeagueProducerTerminalSchema.parse>>();
  let lastJobCheck = -60000;
  for (let polls = 0; ; polls++) {
    signal.throwIfAborted();
    if (performance.now() - started > 2400000)
      throw new Error('Pipeline receiver deadline exceeded');
    const all = await github.list(),
      groups = new Map<
        number,
        { runner: number; total: number; parts: Map<number, PipelineArtifact> }
      >();
    for (const ref of all) {
      const match = partPattern.exec(ref.name);
      if (!match) {
        if (!new RegExp(`^${prefix}-(inputs|baseline|checkpoint|terminal-\\d+)$`).test(ref.name))
          throw new Error('Unexpected pipeline artifact');
        const terminal = /-terminal-(\d+)$/.exec(ref.name);
        if (terminal && !assignments[Number(terminal[1])])
          throw new Error('Foreign terminal runner');
        continue;
      }
      const runner = Number(match[1]),
        partition = Number(match[2]),
        part = Number(match[3]),
        total = Number(match[4]);
      if (
        !assignments[runner]?.partitions.includes(partition) ||
        part >= total ||
        ref.name !== `${prefix}-runner-${runner}-partition-${partition}-part-${part}-of-${total}`
      )
        throw new Error('Foreign producer assignment');
      const group = groups.get(partition) ?? { runner, total, parts: new Map() };
      if (group.runner !== runner || group.total !== total || group.parts.has(part))
        throw new Error('Ambiguous multipart producer');
      group.parts.set(part, ref);
      groups.set(partition, group);
    }
    for (const [partition, group] of [...groups].sort(([a], [b]) => a - b)) {
      if (completed.has(partition) || group.parts.size !== group.total) continue;
      const parts = [...group.parts].sort(([a], [b]) => a - b).map(([, ref]) => ref);
      const spool = join(root, 'receive-' + partition);
      await mkdir(spool);
      try {
        const assembled = await assemblePartition(spool, github, parts);
        const producer = await authenticateLeagueProducer(
          assembled,
          await cloudInput(preparedRoot, prepared, partition),
          github.identity,
          group.runner,
          async () => parts,
        );
        await staging.stage(producer.evidence, join(assembled, 'public'));
        producers.push(producer);
        completed.add(partition);
        parts.forEach((ref) => adopted.set(ref.id, ref));
      } finally {
        await rm(spool, { recursive: true, force: true });
      }
    }
    for (const assignment of assignments) {
      if (terminals.has(assignment.runner)) continue;
      const ref = all.find((a) => a.name === `${prefix}-terminal-${assignment.runner}`);
      if (!ref) continue;
      const path = join(root, 'terminal-' + assignment.runner);
      await github.download(ref, path, (key) => key === 'terminal.json');
      const value = LeagueProducerTerminalSchema.parse(
        await cloudJson(join(path, 'terminal.json')),
      );
      if (
        value.runner !== assignment.runner ||
        canonicalJson(value.identity) !== canonicalJson(github.identity) ||
        canonicalJson(value.partitions) !== canonicalJson(assignment.partitions)
      )
        throw new Error('Terminal assignment mismatch');
      terminals.set(value.runner, value);
    }
    const elapsed = performance.now() - started;
    const checkJobs = terminals.size === assignments.length || elapsed - lastJobCheck >= 60000;
    if (checkJobs) lastJobCheck = elapsed;
    if (checkJobs && (await github.successfulProducers(assignments.length))) {
      if (completed.size !== prepared.inputs.length || terminals.size !== assignments.length)
        throw new Error('Successful jobs have incomplete artifact coverage');
      const refs = [...terminals.values()].flatMap((terminal) => terminal.artifacts);
      if (
        refs.length !== adopted.size ||
        new Set(refs.map((ref) => ref.id)).size !== refs.length ||
        refs.some((ref) => canonicalJson(ref) !== canonicalJson(adopted.get(ref.id)))
      )
        throw new Error('Terminal immutable artifact coverage mismatch');
      return { producers, terminals: [...terminals.values()], metadata: github.metrics() };
    }
    await setTimeout(pipelinePollMs(performance.now() - started, polls), undefined, { signal });
  }
}
