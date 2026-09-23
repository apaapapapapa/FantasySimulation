import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './process.ts';
import { assessReport, sha, type Check, type Identity } from './report.ts';
import { git, sourceIdentity, repositoryRoot, evidencePath } from './source.ts';
import {
  loadProfile,
  loadShardCases,
  bytesHash,
  capture,
  percentile,
  type Capture,
} from './load-contract.ts';
import { loadChecks, compareLoad } from './load-gate.ts';

export const PROFILE_PATH = '.github/harness/load-profile.json';
const CORPUS_PATH = 'packages/engine/fixtures/spatial/corpus.json';

export async function collectLoad(
  inputRoot: string,
  baseline: string | null = null,
  verification = false,
  shard: number | null = null,
) {
  const root = repositoryRoot(inputRoot),
    info = sourceIdentity(root),
    startedAt = new Date().toISOString();
  const dirty = Boolean(git(root, ['status', '--porcelain']));
  if (dirty && (baseline || !verification)) throw new Error('Load evidence needs a clean tree');
  const runnerId = randomUUID(),
    relative =
      shard !== null
        ? `.generated/harness/load-shards/${shard}`
        : baseline
          ? '.generated/harness/load-pair'
          : dirty
            ? '.generated/harness/load-verification'
            : '.generated/harness/load';
  const directory = evidencePath(root, relative);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const corpusPath = join(root, CORPUS_PATH),
    profilePath = join(root, PROFILE_PATH);
  const profile = loadProfile(JSON.parse(readFileSync(profilePath, 'utf8')));
  if (shard !== null) {
    if (!baseline) throw new Error('Load shards require an exact baseline');
    loadShardCases(profile, shard);
  }
  const commands: unknown[] = [],
    captures: { before: Capture | null; after: Capture | null } = { before: null, after: null };
  const errors: string[] = [];
  const regressions: Record<string, unknown> = {};
  let previousProfile: unknown = null;
  let previousCorpusHash = '',
    previousProfileHash = '';
  let boundary: unknown = null;
  const identity: Identity = { ...info, baselineSha: baseline ? sha(baseline) : null };
  const baselineRoot = join(directory, 'baseline');
  const execute = async (command: string, args: string[], cwd: string, name: string) => {
    const result = await runCommand(command, args, cwd, {
      timeoutMs: 300000,
      maxBytes: 4 * 1024 ** 2,
    });
    commands.push({ command: [command, ...args], cwd, ...result, output: `${name}.log` });
    writeFileSync(join(directory, `${name}.log`), result.output);
    if (result.exitCode !== 0 || result.bounded)
      throw new Error(`${name}: exit=${result.exitCode}, bounded=${result.bounded}`);
  };
  try {
    await execute(process.execPath, ['scripts/engine-identity.ts'], root, 'engine-check-after');
    if (baseline) {
      // Exactly the supplied commit; never a branch name and never a previous unrelated CI timing.
      await execute(
        'git',
        ['worktree', 'add', '--detach', baselineRoot, sha(baseline)],
        root,
        'checkout',
      );
      await execute(
        'vp',
        ['install', '--frozen-lockfile', '--', '--store-dir', join(root, '.generated/pm-store')],
        baselineRoot,
        'install',
      );
      await execute(
        'vp',
        ['exec', 'node', 'scripts/engine-identity.ts'],
        baselineRoot,
        'engine-check-before',
      );
      const paths = git(root, ['ls-tree', '--name-only', baseline, '--', PROFILE_PATH]);
      if (paths)
        previousProfile = loadProfile(
          JSON.parse(git(root, ['show', `${baseline}:${PROFILE_PATH}`])),
        );
      const previousCorpusBytes = readFileSync(join(baselineRoot, CORPUS_PATH));
      const previousProfileBytes = previousProfile
        ? readFileSync(join(baselineRoot, PROFILE_PATH))
        : readFileSync(profilePath);
      previousCorpusHash = bytesHash(previousCorpusBytes);
      previousProfileHash = bytesHash(previousProfileBytes);
      writeFileSync(join(directory, 'baseline-corpus.json'), previousCorpusBytes);
      writeFileSync(join(directory, 'baseline-profile.json'), previousProfileBytes);
      try {
        boundary = JSON.parse(
          readFileSync(join(root, '.generated/harness/corpus/report.json'), 'utf8'),
        );
      } catch {
        /* Transitions require current independent boundary evidence. */
      }
      writeFileSync(join(directory, 'boundary.json'), JSON.stringify(boundary, null, 2) + '\n');
      for (const [side, target, source] of [
        ['before', baselineRoot, baseline],
        ['after', root, info.sourceSha],
      ] as const) {
        const output = join(directory, `regression-${side}.json`);
        const args = [
          'exec',
          'node',
          join(root, 'scripts/harness/regression-probe.ts'),
          target,
          source,
          output,
        ];
        const command = await runCommand('vp', args, target, { timeoutMs: 30000 });
        commands.push({ command: ['vp', ...args], cwd: target, ...command });
        if (command.bounded || (command.exitCode !== 0 && command.exitCode !== 1))
          throw new Error('Regression setup/import failed');
        regressions[side] = JSON.parse(readFileSync(output, 'utf8')) as unknown;
      }
    }
    for (let pair = 0; pair < (baseline ? profile.samples : 1); pair++) {
      const sides = baseline
        ? pair % 2
          ? (['after', 'before'] as const)
          : (['before', 'after'] as const)
        : (['after'] as const);
      for (const side of sides) {
        const target = side === 'before' ? baselineRoot : root;
        const source = side === 'before' ? baseline! : info.sourceSha;
        const name = `${pair}-${side}`,
          output = join(directory, `${name}.json`);
        await execute(
          'vp',
          [
            'exec',
            'node',
            join(root, 'scripts/harness/load-capture.ts'),
            target,
            source,
            side === 'before' ? join(directory, 'baseline-corpus.json') : corpusPath,
            side === 'before' ? join(directory, 'baseline-profile.json') : profilePath,
            output,
            String(baseline ? 1 : profile.samples),
            runnerId,
            dirty ? 'verification' : 'evidence',
            ...(shard === null ? [] : [String(shard)]),
          ],
          target,
          name,
        );
        const observed = capture(JSON.parse(readFileSync(output, 'utf8')));
        if (
          observed.driverHash !==
          bytesHash(readFileSync(join(root, 'scripts/harness/load-capture.ts')))
        )
          throw new Error('Stale driver');
        if (captures[side]) captures[side].samples.push(...observed.samples);
        else captures[side] = observed;
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (baseline) {
      try {
        git(root, ['worktree', 'remove', '--force', baselineRoot]);
      } catch {
        errors.push('Baseline worktree cleanup incomplete');
      }
    }
  }
  const checks: Check[] = [];
  if (baseline) {
    const before = regressions.before as { status?: string } | undefined,
      after = regressions.after as { status?: string } | undefined;
    const reproduced = before?.status === 'assertion-failed' && after?.status === 'passed';
    const retained = before?.status === 'passed' && after?.status === 'passed';
    checks.push({
      id: 'load:regression',
      required: true,
      status: reproduced || retained ? 'pass' : 'unknown',
      reason: reproduced
        ? 'Actual baseline assertion failed; the same candidate probe passed'
        : retained
          ? 'Both revisions retain the regression fix; no fresh reproduction claimed'
          : 'No valid assertion-level regression evidence',
      evidence: [
        { uri: `${relative}/regression-before.json`, sourceSha: info.sourceSha },
        { uri: `${relative}/regression-after.json`, sourceSha: info.sourceSha },
      ],
    });
  }
  for (const side of baseline ? (['before', 'after'] as const) : (['after'] as const)) {
    const expected = {
      sourceSha: side === 'before' ? baseline! : info.sourceSha,
      driverSha: info.sourceSha,
      corpusHash: side === 'before' ? previousCorpusHash : bytesHash(readFileSync(corpusPath)),
      profileHash: side === 'before' ? previousProfileHash : bytesHash(readFileSync(profilePath)),
      samples: profile.samples,
      requireCommitted: !dirty,
      ...(shard === null
        ? {}
        : {
            caseIds: loadShardCases(
              side === 'before' && previousProfile ? loadProfile(previousProfile) : profile,
              shard,
            ),
          }),
    };
    checks.push(
      ...loadChecks(
        captures[side],
        side === 'before' && previousProfile ? loadProfile(previousProfile) : profile,
        expected,
      ).map((c) => ({
        ...c,
        id: baseline ? `${c.id}:${side}` : c.id,
        evidence: [{ uri: `${relative}/results.json`, sourceSha: info.sourceSha }],
      })),
    );
  }
  if (shard === null && baseline && captures.before && captures.after) {
    let reviews: unknown = null;
    try {
      reviews = JSON.parse(readFileSync(join(root, '.github/harness/load-reviews.json'), 'utf8'));
    } catch {
      /* No change waiver. */
    }
    checks.push(
      ...compareLoad(
        identity,
        captures.before,
        captures.after,
        previousProfile,
        profile,
        reviews,
        boundary,
      ),
    );
  }
  checks.push({
    id: 'load:collection',
    required: true,
    status: errors.length ? 'unknown' : 'pass',
    reason:
      errors.join('; ') ||
      (baseline
        ? 'Completed bounded commands on the same runner with alternating pairs and warmups'
        : dirty
          ? 'Working-tree verification only; completed bounded samples after warmup, not committed evidence'
          : 'Completed bounded samples after warmup on the committed source'),
    evidence: [{ uri: `${relative}/commands.json`, sourceSha: info.sourceSha }],
  });
  if (
    git(root, ['rev-parse', 'HEAD']) !== info.sourceSha ||
    (!dirty && git(root, ['status', '--porcelain']))
  )
    checks.push({
      id: 'load:source-stable',
      required: true,
      status: 'fail',
      reason: 'Source changed during measurement',
      evidence: [],
    });
  writeFileSync(
    join(directory, 'commands.json'),
    JSON.stringify(
      {
        runnerId,
        commands,
        errors,
        shard,
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(directory, 'results.json'),
    JSON.stringify(
      {
        ...identity,
        sourceState: dirty ? 'working-tree' : 'clean',
        runnerId,
        profile,
        previousProfile,
        ...captures,
      },
      null,
      2,
    ) + '\n',
  );
  const performance = Object.fromEntries(
    Object.entries(captures).map(([side, raw]) => [
      side,
      raw &&
        Object.keys(
          side === 'before' && previousProfile
            ? loadProfile(previousProfile).limits
            : profile.limits,
        ).map((id) => {
          const rows = raw.samples.filter((s) => s.id === id);
          return {
            id,
            samples: rows.length,
            medianMs: rows.length
              ? percentile(
                  rows.map((s) => s.elapsedMs),
                  0.5,
                )
              : null,
            p95Ms: rows.length
              ? percentile(
                  rows.map((s) => s.elapsedMs),
                  0.95,
                )
              : null,
            cpuMedianMicros: rows.length
              ? percentile(
                  rows.map((s) => s.cpuMicros),
                  0.5,
                )
              : null,
            peakRssBytes:
              rows.length && rows.every((s) => s.peakRssBytes !== null)
                ? Math.max(...rows.map((s) => s.peakRssBytes!))
                : null,
            incompleteReason: rows.length === profile.samples ? null : 'Incomplete profile samples',
            memoryReason: rows.find((s) => s.memoryReason)?.memoryReason ?? null,
          };
        }),
    ]),
  );
  writeFileSync(
    join(directory, 'performance.json'),
    JSON.stringify(
      {
        performance,
        conditions:
          'Direct real engine; prepare/input generation excluded, hashing and bounded record collection included. RSS is process high-water including warmup. Timings/RSS are observational, no noisy thresholds.',
        workerQueueMs: null,
        persistenceWallMs: null,
        reason:
          'This profile measures direct engine execution; Worker compute/backpressure/heap/WASM observations are in worker-corpus/results.json. No persistence is performed.',
      },
      null,
      2,
    ) + '\n',
  );
  const assessed = assessReport(
    {
      ...identity,
      schemaVersion: 1,
      producer: dirty ? 'load-verification' : 'load-runner',
      startedAt,
      finishedAt: new Date().toISOString(),
      checks,
    },
    baseline
      ? [
          'load:budget:before',
          'load:budget:after',
          ...(shard === null ? ['load:comparison'] : []),
          'load:collection',
          'load:regression',
        ]
      : ['load:budget', 'load:collection'],
  );
  writeFileSync(join(directory, 'report.json'), JSON.stringify(assessed.report, null, 2) + '\n');
  return assessed;
}
