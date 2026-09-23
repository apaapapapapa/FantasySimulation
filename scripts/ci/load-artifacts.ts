import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readBoundedJson } from '../harness/files.ts';
import { assessReport, record, type Identity, type Check, type Report } from '../harness/report.ts';
import {
  capture,
  loadProfile,
  loadShardCases,
  LOAD_SHARDS,
  bytesHash,
  fixtureHash,
  type Capture,
} from '../harness/load-contract.ts';
import {
  loadChecks,
  compareLoad,
  validateLoadPair,
  compareLoadSeries,
  type LoadSeries,
} from '../harness/load-gate.ts';

/** A passing summary cannot substitute for the raw trial/command artifacts it cites. */
export function readLoadArtifacts(
  root: string,
  directory: string,
  info: Identity,
  paired: boolean,
  shard: number | null = null,
) {
  const json = (path: string) => readBoundedJson(join(directory, path));
  const raw = record(json('results.json'));
  const profileBytes = readFileSync(join(root, '.github/harness/load-profile.json'));
  const profile = loadProfile(JSON.parse(profileBytes.toString('utf8')));
  const corpusBytes = readFileSync(join(root, 'packages/engine/fixtures/spatial/corpus.json'));
  const driverHash = bytesHash(readFileSync(join(root, 'scripts/harness/load-capture.ts')));
  const commands = record(json('commands.json'));
  if (
    shard !== null &&
    (commands.shard !== shard ||
      commands.runId !== (process.env.GITHUB_RUN_ID ?? null) ||
      commands.runAttempt !== (process.env.GITHUB_RUN_ATTEMPT ?? null))
  )
    throw new Error('Wrong load shard/run attempt');
  if (
    !Array.isArray(commands.commands) ||
    !commands.commands.length ||
    !isDeepStrictEqual(commands.errors, [])
  )
    throw new Error('Missing or interrupted command artifacts');
  for (const item of commands.commands) {
    const command = record(item);
    if (
      command.bounded !== false ||
      (command.exitCode !== 0 &&
        !(
          paired &&
          command.exitCode === 1 &&
          Array.isArray(command.command) &&
          command.command.some(
            (arg) => typeof arg === 'string' && arg.endsWith('/regression-probe.ts'),
          )
        ))
    )
      throw new Error('Unsuccessful load command');
    if (typeof command.output === 'string' && command.output.endsWith('.log')) {
      if (!/^[a-z0-9-]+\.log$/.test(command.output)) throw new Error('Invalid command log path');
      readFileSync(join(directory, command.output));
    }
  }
  json('performance.json');
  for (const side of paired ? ['before', 'after'] : ['after']) {
    const observed = capture(raw[side]);
    const inputBytes =
      side === 'before' ? readFileSync(join(directory, 'baseline-corpus.json')) : corpusBytes;
    const budgetBytes =
      side === 'before' ? readFileSync(join(directory, 'baseline-profile.json')) : profileBytes;
    if (observed.driverHash !== driverHash || observed.runnerId !== commands.runnerId)
      throw new Error('Wrong driver or runner artifacts');
    if (observed.fixtureHash !== fixtureHash(JSON.parse(inputBytes.toString('utf8'))))
      throw new Error('Wrong fixed input identity');
    const checks = loadChecks(
      observed,
      side === 'before' && raw.previousProfile ? loadProfile(raw.previousProfile) : profile,
      {
        sourceSha: side === 'before' ? info.baselineSha! : info.sourceSha,
        driverSha: info.sourceSha,
        corpusHash: bytesHash(inputBytes),
        profileHash: bytesHash(budgetBytes),
        samples: profile.samples,
        ...(shard === null
          ? {}
          : {
              caseIds: loadShardCases(loadProfile(JSON.parse(budgetBytes.toString('utf8'))), shard),
            }),
      },
    );
    if (checks.some((check) => check.status !== 'pass'))
      throw new Error('Invalid raw load samples');
    const rows = Array.from({ length: paired ? profile.samples : 1 }, (_, trial) => {
      const trialCapture = capture(json(`${trial}-${side}.json`));
      const { samples, ...trialIdentity } = trialCapture;
      const { samples: _aggregateSamples, ...expectedIdentity } = observed;
      if (!isDeepStrictEqual(trialIdentity, expectedIdentity)) throw new Error('Stale raw trial');
      return samples;
    }).flat();
    if (!isDeepStrictEqual(rows, observed.samples))
      throw new Error('Raw trials differ from aggregate');
  }
  if (paired) {
    let reviews: unknown = null;
    try {
      reviews = readBoundedJson(join(root, '.github/harness/load-reviews.json'));
    } catch {
      /* Reviewed only when needed. */
    }
    if (shard !== null)
      validateLoadPair(
        info,
        capture(raw.before),
        capture(raw.after),
        raw.previousProfile,
        profile,
        (limits) => loadShardCases(limits, shard),
      );
    else if (
      compareLoad(
        info,
        capture(raw.before),
        capture(raw.after),
        raw.previousProfile,
        profile,
        reviews,
        json('boundary.json'),
      ).some((check) => check.required && check.status !== 'pass')
    )
      throw new Error('Invalid raw paired comparison');
    for (const side of ['before', 'after']) {
      const probe = record(json(`regression-${side}.json`));
      if (
        probe.sourceSha !== (side === 'before' ? info.baselineSha : info.sourceSha) ||
        probe.driverSha !== info.sourceSha ||
        !['passed', ...(side === 'before' ? ['assertion-failed'] : [])].includes(
          String(probe.status),
        )
      )
        throw new Error('Incomplete regression artifacts');
    }
  }
  return json('report.json');
}

/** Keep each physical runner's raw captures intact; only combine deterministic costs across cases. */
export function readPairedShards(
  root: string,
  directory: string,
  info: Identity,
  boundary: unknown,
) {
  const profile = loadProfile(readBoundedJson(join(root, '.github/harness/load-profile.json')));
  const captures: { before: Capture[]; after: Capture[] } = { before: [], after: [] };
  const profiles: unknown[] = [],
    checks: Check[] = [];
  for (let shard = 1; shard <= LOAD_SHARDS; shard++) {
    const path = join(directory, `harness-load-${shard}`);
    const receipt = assessReport(readLoadArtifacts(root, path, info, true, shard), [
      'load:budget:before',
      'load:budget:after',
      'load:collection',
      'load:regression',
    ]);
    if (
      receipt.exitCode !== 0 ||
      receipt.report.sourceSha !== info.sourceSha ||
      receipt.report.baselineSha !== info.baselineSha ||
      receipt.report.producer !== 'load-runner'
    )
      throw new Error('Incomplete load shard report');
    const raw = record(readBoundedJson(join(path, 'results.json')));
    captures.before.push(capture(raw.before));
    captures.after.push(capture(raw.after));
    profiles.push(raw.previousProfile);
    checks.push({
      id: `load:shard:${shard}`,
      required: true,
      status: 'pass',
      reason:
        'Raw before/after trials, commands, budgets and regression probe verified on one runner',
      evidence: [
        { uri: `.generated/harness/load-shards/${shard}/report.json`, sourceSha: info.sourceSha },
      ],
    });
  }
  if (profiles.some((profile) => !isDeepStrictEqual(profile, profiles[0])))
    throw new Error('Inconsistent baseline profiles');
  const series = (rows: Capture[]): LoadSeries => {
    const first = rows[0]!;
    for (const row of rows) {
      if (
        row.fixtureHash !== first.fixtureHash ||
        row.corpusHash !== first.corpusHash ||
        row.profileHash !== first.profileHash ||
        row.toolchain.node !== first.toolchain.node ||
        row.toolchain.packageManager !== first.toolchain.packageManager ||
        row.toolchain.lockHash !== first.toolchain.lockHash
      )
        throw new Error('Load shards measured different inputs or toolchains');
    }
    return {
      fixtureHash: first.fixtureHash,
      toolchain: { node: first.toolchain.node, packageManager: first.toolchain.packageManager },
      samples: rows.flatMap((row) => row.samples),
    };
  };
  let reviews: unknown = null;
  try {
    reviews = readBoundedJson(join(root, '.github/harness/load-reviews.json'));
  } catch {
    /* Required only on actual profile/cost changes. */
  }
  const evidence = checks.flatMap((check) => check.evidence);
  checks.push(
    ...compareLoadSeries(
      info,
      series(captures.before),
      series(captures.after),
      profiles[0],
      profile,
      reviews,
      boundary,
    ).map((check) => ({ ...check, evidence })),
  );
  for (const id of [
    'load:budget:before',
    'load:budget:after',
    'load:regression',
    'load:collection',
  ])
    checks.push({
      id,
      required: true,
      status: 'pass',
      reason: 'All planned case shards and five samples per case validated',
      evidence,
    });
  const at = new Date().toISOString();
  const report: Report = {
    ...info,
    schemaVersion: 1,
    producer: 'load-runner',
    startedAt: at,
    finishedAt: at,
    checks,
  };
  return assessReport(
    report,
    checks.filter((check) => check.required).map((check) => check.id),
  ).report;
}
