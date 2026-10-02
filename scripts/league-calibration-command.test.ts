import { withReplayDirectory } from '@fantasy/api/testing';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vite-plus/test';
const fixture = vi.hoisted(() => ({
  prepare: vi.fn(),
  ci: vi.fn(),
  auth: vi.fn(),
  upload: vi.fn(),
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
vi.mock('./league-calibration-upload.ts', () => ({ uploadCalibrationArtifact: fixture.upload }));
vi.mock('./league-pipeline-policy.ts', () => ({ pipelineCi: fixture.ci }));
vi.mock('./league-pipeline-artifacts.ts', () => ({
  PipelineArtifacts: class {
    authenticateRun = fixture.auth;
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
it('keeps failure diagnostics local when CI, run authentication or history reservation refuses admission', async () => {
  const args = [...process.argv],
    exit = process.exitCode;
  process.argv[2] = 'prepare';
  vi.stubEnv('LEAGUE_RUNNERS', '2');
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
    for (const rejection of [fixture.ci, fixture.auth, fixture.prepare]) {
      fixture.ci.mockReset().mockResolvedValue(undefined);
      fixture.auth.mockReset().mockResolvedValue(undefined);
      fixture.prepare.mockReset().mockResolvedValue(undefined);
      fixture.upload.mockReset();
      rejection.mockRejectedValue(new Error('admission refused'));
      await withReplayDirectory(async (root) => {
        await runPilotCommand(true, root);
        expect(
          JSON.parse(await readFile(join(root, 'phase-measurement.json'), 'utf8')),
        ).toMatchObject({
          status: 'failed',
          failure: 'admission refused',
          formalAcceptance: false,
        });
      });
      expect(process.exitCode).toBe(1);
      expect(fixture.upload).not.toHaveBeenCalled();
    }
  } finally {
    process.argv = args;
    process.exitCode = exit;
    vi.unstubAllEnvs();
  }
});
