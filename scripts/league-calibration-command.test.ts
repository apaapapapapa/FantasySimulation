import { withReplayDirectory } from '@fantasy/api/testing';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vite-plus/test';
const fixture = vi.hoisted(() => ({
  prepare: vi.fn(),
  ci: vi.fn(),
  auth: vi.fn(),
  upload: vi.fn(),
  reserve: vi.fn(),
  count: vi.fn(),
}));
const source = { sha: 'a'.repeat(40), node: 'v24.19.0', platform: 'linux', arch: 'x64' };
vi.mock('@fantasy/api/tooling', async (original) => ({
  ...(await original<typeof import('@fantasy/api/tooling')>()),
  executionSource: () => ({
    sha: 'a'.repeat(40),
    node: 'v24.19.0',
    platform: 'linux',
    arch: 'x64',
  }),
}));
vi.mock('./league-partition-pilot-driver.ts', () => ({
  prepareRunnerCalibration: fixture.prepare,
  computeRunnerCalibration: vi.fn(),
  consumeRunnerCalibration: vi.fn(),
  preparePartitionPilot: vi.fn(),
  computePartitionPilot: vi.fn(),
  consumePartitionPilot: vi.fn(),
}));
vi.mock('./league-calibration-upload.ts', () => ({
  uploadCalibrationArtifact: fixture.upload,
  beginCalibrationTransportJob: fixture.reserve,
  calibrationTransportSnapshot: () => null,
}));
vi.mock('./league-pipeline-policy.ts', () => ({ pipelineCi: fixture.ci }));
vi.mock('./league-pipeline-artifacts.ts', () => ({
  PipelineArtifacts: class {
    authenticateRun = fixture.auth;
    request = fixture.count;
    metrics() {
      return {};
    }
    reserveOtherMetadata() {}
  },
}));
vi.mock('./league-pipeline-context.ts', () => ({
  requiredPipeline: (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error('Missing ' + name);
    return value;
  },
  pipelineContext: async (root: string) => ({
    root,
    identity: {
      source: { sha: 'a'.repeat(40), node: 'v24.19.0', platform: 'linux', arch: 'x64' },
      runId: 123,
      runAttempt: 1,
      validatorDigest: 'sha256:' + 'b'.repeat(64),
    },
    token: 'fixture',
    ciRun: 99,
    prefix: 'league-123-1',
  }),
}));
import { runPilotCommand } from './league-pilot-command.ts';
it('emits bounded redacted failure diagnostics without SDK allocation when admission fails', async () => {
  const args = [...process.argv],
    exit = process.exitCode;
  process.argv[2] = 'prepare';
  vi.stubEnv('LEAGUE_RUNNERS', '2');
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const secret = 'fixture-artifact-secret';
  vi.stubEnv('LEAGUE_ARTIFACT_TOKEN', secret);
  const rejected = 'admission refused ' + secret + ' github_pat_fixture_secret ' + 'x'.repeat(3000);
  vi.stubEnv(
    'LEAGUE_CALIBRATION_BUDGET',
    JSON.stringify({
      schemaVersion: 1,
      kind: 'owner-attestation',
      sourceSha: source.sha,
      accountLogin: 'apaapapapapa',
      observedAt: new Date().toISOString(),
      retentionDays: 1,
      artifactByteHoursRemaining: 10000000000,
      competingWorkloadByteHours: 0,
      reserveByteHours: 1,
      readproofEvidenceURL: 'https://github.com/settings/billing/usage',
    }),
  );
  try {
    for (const rejection of [fixture.ci, fixture.auth, fixture.count, fixture.prepare]) {
      fixture.ci.mockReset().mockResolvedValue(undefined);
      fixture.auth.mockReset().mockResolvedValue(undefined);
      fixture.prepare.mockReset().mockResolvedValue(undefined);
      fixture.upload.mockReset();
      fixture.reserve.mockReset();
      fixture.count.mockReset().mockResolvedValue({ total_count: 0 });
      diagnostic.mockClear();
      rejection.mockRejectedValue(new Error(rejected));
      await withReplayDirectory(async (root) => {
        await runPilotCommand(true, root);
        expect(
          JSON.parse(await readFile(join(root, 'phase-measurement.json'), 'utf8')),
        ).toMatchObject({
          status: 'failed',
          failure: rejected,
          formalAcceptance: false,
        });
      });
      expect(process.exitCode).toBe(1);
      expect(fixture.upload).not.toHaveBeenCalled();
      if (rejection === fixture.prepare) {
        expect(fixture.reserve).toHaveBeenCalledWith('prepare', 2, 'league-123-1', 0);
        expect(fixture.reserve.mock.invocationCallOrder[0]).toBeLessThan(
          fixture.prepare.mock.invocationCallOrder[0]!,
        );
      } else expect(fixture.reserve).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledOnce();
      const output = JSON.parse(diagnostic.mock.calls[0]![0] as string);
      expect(output).toMatchObject({
        command: 'prepare',
        status: 'failed',
        formalAcceptance: false,
        error: { type: 'Error' },
      });
      expect(output.error.message).toContain('[REDACTED]');
      expect(output.error.message).not.toContain(secret);
      expect(output.error.message).not.toContain('github_pat_fixture_secret');
      expect(output.error.message.length).toBeLessThanOrEqual(2048);
      expect(output.error).not.toHaveProperty('stack');
    }
  } finally {
    process.argv = args;
    process.exitCode = exit;
    vi.unstubAllEnvs();
    diagnostic.mockRestore();
  }
});
