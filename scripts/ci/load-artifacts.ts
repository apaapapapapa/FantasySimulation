import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readBoundedJson } from '../harness/files.ts';
import { record, type Identity } from '../harness/report.ts';
import { capture, loadProfile, bytesHash, fixtureHash } from '../harness/load-contract.ts';
import { loadChecks, compareLoad } from '../harness/load-gate.ts';

/** A passing summary cannot substitute for the raw trial/command artifacts it cites. */
export function readLoadArtifacts(
  root: string,
  directory: string,
  info: Identity,
  paired: boolean,
) {
  const json = (path: string) => readBoundedJson(join(directory, path));
  const raw = record(json('results.json'));
  const profileBytes = readFileSync(join(root, '.github/harness/load-profile.json'));
  const profile = loadProfile(JSON.parse(profileBytes.toString('utf8')));
  const corpusBytes = readFileSync(join(root, 'packages/engine/fixtures/spatial/corpus.json'));
  const driverHash = bytesHash(readFileSync(join(root, 'scripts/harness/load-capture.ts')));
  const commands = record(json('commands.json'));
  if (
    !Array.isArray(commands.commands) ||
    !commands.commands.length ||
    !isDeepStrictEqual(commands.errors, [])
  )
    throw new Error('Missing or interrupted command artifacts');
  for (const item of commands.commands) {
    const command = record(item);
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
    if (
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
