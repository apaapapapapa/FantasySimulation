import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';
import { OperationError } from '@fantasy/api/tooling';
import { LeagueCloudInputSchema } from '@fantasy/domain/spatial';
import { PublicationFailure } from '../publication/publication-remote.ts';
import { leagueFailure, leagueFailureSummary, reportLeagueFailure } from './league-diagnostics.ts';
import { reserveLeagueUsage } from './league-budget.ts';
import { cloudJson, writeCloudJson } from './league-cloud-files.ts';

const secret = 'TEST_SECRET_DO_NOT_PRINT';
const privateError = () =>
  new Error(`Authorization: Bearer ${secret}`, {
    cause: new Error(`https://private.example/${secret}?signature=${secret}`),
  });
afterEach(() => vi.restoreAllMocks());

it('retains source codes from admission and checksum verification', async () => {
  let failure: unknown;
  try {
    reserveLeagueUsage(null, {
      id: 'fixture',
      sourceSha: 'a'.repeat(40),
      day: '2026-09-26',
      classA: 900000,
      classB: 0,
      worker: 0,
    });
  } catch (error) {
    failure = error;
  }
  expect(leagueFailure(failure, { command: 'admit' })).toMatchObject({
    code: 'BUDGET_EXCEEDED',
    retry: 'conditional',
  });
  await withReplayDirectory(async (root) => {
    const path = join(root, 'input.json');
    const ref = await writeCloudJson(path, { value: secret });
    try {
      await cloudJson(path, { ...ref, hash: `sha256:${'0'.repeat(64)}` });
    } catch (error) {
      failure = error;
    }
    expect(leagueFailure(failure, { command: 'run' })).toMatchObject({
      code: 'DATA_INVALID',
      retry: 'no',
    });
  });
});

it.each([
  ['INPUT_INVALID', 'no'],
  ['IDENTITY_MISMATCH', 'no'],
  ['BUDGET_EXCEEDED', 'conditional'],
  ['DATA_INVALID', 'no'],
  ['PUBLICATION_CONFLICT', 'conditional'],
  ['REMOTE_AUTH', 'no'],
  ['REMOTE_UNAVAILABLE', 'conditional'],
  ['USAGE_CONSUMED', 'no'],
  ['USAGE_UNVERIFIED', 'unknown'],
] as const)('classifies %s by type/code and never includes private descriptions', (code, retry) => {
  const error = new OperationError(code, secret, `sha256:${secret}`);
  error.cause = privateError();
  const report = leagueFailure(error, { command: 'prepare', executionId: secret });
  expect(report).toMatchObject({ status: 'failed', code, retry, phase: 'planning' });
  expect(report).not.toHaveProperty('targetHash');
  expect(report).not.toHaveProperty('executionId');
  expect(JSON.stringify(report) + leagueFailureSummary(report)).not.toContain(secret);
});

it.each([
  ['not-committed', 'PUBLICATION_NOT_COMMITTED', 'conditional'],
  ['commit-unknown', 'PUBLICATION_COMMIT_UNKNOWN', 'unknown'],
  ['committed-unverified', 'PUBLICATION_UNVERIFIED', 'conditional'],
] as const)('retains publication recovery semantics for %s', (phase, code, retry) => {
  const report = leagueFailure(new PublicationFailure(phase, privateError()), {
    command: 'publish',
  });
  expect(report).toMatchObject({ code, retry, phase: 'publication', publicationState: phase });
  expect(report.action).toContain('identical publication input');
  expect(JSON.stringify(report) + leagueFailureSummary(report)).not.toContain(secret);
});

it('uses only the known publication wrapper and never walks arbitrary causes or trusts name/code duck typing', () => {
  const known = new OperationError('BUDGET_EXCEEDED', secret);
  expect(
    leagueFailure(new PublicationFailure('not-committed', known), { command: 'admit' }).code,
  ).toBe('BUDGET_EXCEEDED');
  for (const error of [
    privateError(),
    secret,
    null,
    { name: 'OperationError', code: 'DATA_INVALID', cause: known },
    new Error(secret, { cause: known }),
  ]) {
    const report = leagueFailure(error, { command: secret });
    expect(report).toMatchObject({
      code: 'UNKNOWN',
      command: 'unknown',
      phase: 'validation',
      retry: 'unknown',
    });
    expect(JSON.stringify(report)).not.toContain(secret);
  }
  const invalid = LeagueCloudInputSchema.safeParse({ secret });
  expect(invalid.success).toBe(false);
  if (!invalid.success)
    expect(leagueFailure(invalid.error, { command: 'prepare' }).code).toBe('INPUT_INVALID');
});

it.each([
  secret,
  `https://host/${secret}`,
  `sha256:${'a'.repeat(64)}\n${secret}`,
  'a'.repeat(10000),
  `league-123-1\r${secret}`,
  `sha256:${'a'.repeat(64)}\n`,
  'league-123-1\n',
  'league-123-1\u2028',
])('omits noncanonical, oversized or control-bearing identifiers', (id) => {
  const report = leagueFailure(new OperationError('DATA_INVALID', secret, id), {
    command: 'finish',
    executionId: id,
  });
  expect(report).not.toHaveProperty('targetHash');
  expect(report).not.toHaveProperty('executionId');
  expect(JSON.stringify(report).length).toBeLessThan(1500);
});

it('emits the same allowlisted record to stderr, report and human summary even when one sink fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await withReplayDirectory(async (root) => {
    const context = { command: 'run', executionId: 'league-12345-2' };
    const error = new OperationError('DATA_INVALID', secret, `sha256:${'a'.repeat(64)}`);
    const summary = join(root, 'summary.md');
    await reportLeagueFailure(error, context, root, summary);
    const report = JSON.parse(await readFile(join(root, 'reports/failure-run.json'), 'utf8'));
    expect(report).toMatchObject({
      phase: 'execution',
      targetHash: `sha256:${'a'.repeat(64)}`,
      executionId: 'league-12345-2',
    });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(report);
    expect(await readFile(summary, 'utf8')).toBe(leagueFailureSummary(report));
    // Immutable report collision still writes the summary; a failing summary still writes JSON.
    await reportLeagueFailure(privateError(), context, root, summary);
    await mkdir(join(root, 'bad-summary'));
    await reportLeagueFailure(
      privateError(),
      { command: 'finish' },
      root,
      join(root, 'bad-summary'),
    );
    expect(JSON.parse(await readFile(join(root, 'reports/failure-finish.json'), 'utf8')).code).toBe(
      'UNKNOWN',
    );
    expect(log.mock.calls.flat().join(' ')).toContain('LEAGUE_REPORT_WRITE_FAILED');
    expect(log.mock.calls.flat().join(' ') + (await readFile(summary, 'utf8'))).not.toContain(
      secret,
    );
  });
});
