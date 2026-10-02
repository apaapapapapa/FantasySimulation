import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { calibrationEncodedBytes } from './league-calibration-upload.ts';

const upload = vi.hoisted(() => vi.fn());
vi.mock('@actions/artifact', () => ({ default: { uploadArtifact: upload } }));
vi.mock('@fantasy/api/tooling', async (original) => ({
  ...(await original<typeof import('@fantasy/api/tooling')>()),
  executionSource: () => ({ sha: 'a'.repeat(40) }),
}));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('pinned SDK local encoded-byte admission', () => {
  it('measures actual nested Unicode ZIP bytes with no artifact service allocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'calibration-zip-'));
    roots.push(root);
    await mkdir(join(root, 'nested'));
    const file = join(root, 'nested', '記録.json');
    await writeFile(file, JSON.stringify({ recorded: true, payload: 'x'.repeat(1024) }));
    const bytes = await calibrationEncodedBytes([file], root, 4096);
    expect(bytes).toBeGreaterThan(1024);
    expect(bytes).toBeLessThan(4096);
    expect(await calibrationEncodedBytes([file], root, bytes)).toBe(bytes);
    await expect(calibrationEncodedBytes([file], root, bytes - 1)).rejects.toThrow(
      'before service allocation',
    );
  });
  it('rejects a large archive locally before an SDK upload could start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'calibration-zip-'));
    roots.push(root);
    const file = join(root, 'large.bin');
    await writeFile(file, Buffer.alloc(1024 * 1024, 7));
    await expect(calibrationEncodedBytes([file], root, 1024)).rejects.toThrow(
      'before service allocation',
    );
  });
});
async function budgetFixture() {
  const root = await mkdtemp(join(tmpdir(), 'calibration-upload-'));
  roots.push(root);
  const file = join(root, 'metrics.json');
  await writeFile(file, 'x'.repeat(350000));
  vi.stubEnv(
    'LEAGUE_CALIBRATION_BUDGET',
    JSON.stringify({
      schemaVersion: 1,
      kind: 'owner-attestation',
      sourceSha: 'a'.repeat(40),
      accountLogin: 'apaapapapapa',
      observedAt: new Date().toISOString(),
      retentionDays: 1,
      artifactByteHoursRemaining: 10000000000,
      competingWorkloadByteHours: 0,
      reserveByteHours: 1,
      readproofEvidenceURL: 'https://github.com/settings/billing/usage',
    }),
  );
  vi.resetModules();
  upload.mockReset();
  return { root, file, api: await import('./league-calibration-upload.ts') };
}
it('reserves aggregate capacity atomically before concurrent SDK allocation', async () => {
  const { root, file, api } = await budgetFixture();
  upload.mockImplementation(async (_name, files, directory, options) => {
    expect(options).toEqual({ retentionDays: 1, compressionLevel: 0 });
    return {
      id: 1,
      size: await api.calibrationEncodedBytes(files, directory, 1048576),
      digest: 'b'.repeat(64),
    };
  });
  const outcomes = await Promise.allSettled([
    api.uploadCalibrationArtifact('league-one-metrics', [file], root),
    api.uploadCalibrationArtifact('league-two-metrics', [file], root),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  expect(upload).toHaveBeenCalledTimes(1);
  vi.unstubAllEnvs();
});
it('never refunds an uncertain service allocation or makes an unbudgeted retry', async () => {
  const { root, file, api } = await budgetFixture();
  upload.mockRejectedValue(new Error('uncertain SDK outcome'));
  await expect(api.uploadCalibrationArtifact('league-one-metrics', [file], root)).rejects.toThrow(
    'uncertain SDK outcome',
  );
  await expect(api.uploadCalibrationArtifact('league-two-metrics', [file], root)).rejects.toThrow(
    'before service allocation',
  );
  expect(upload).toHaveBeenCalledTimes(1);
  vi.unstubAllEnvs();
});
it('rejects missing source-bound budget before any SDK upload', async () => {
  const { root, file, api } = await budgetFixture();
  vi.stubEnv('LEAGUE_CALIBRATION_BUDGET', '');
  await expect(api.uploadCalibrationArtifact('league-one-metrics', [file], root)).rejects.toThrow();
  expect(upload).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
