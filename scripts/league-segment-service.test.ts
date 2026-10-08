import { afterEach, expect, it, vi } from 'vite-plus/test';
import { boundedArtifactResponse, LEAGUE_ARCHIVE_BYTES } from './league-archive.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import { pipelineActionsFixture } from './test-support/league-actions.ts';
import { matchSegmentServiceArtifact } from './league-segment-service.ts';

afterEach(() => vi.unstubAllGlobals());

it('matches exactly one authenticated immutable receipt and rejects foreign acknowledgement fields', () => {
  const receipt = {
    id: 456,
    name: 'league-123-1-segment-0-0-upload-0.zip',
    bytes: 1024,
    digest: 'sha256:' + 'c'.repeat(64),
  };
  expect(matchSegmentServiceArtifact([{ ...receipt }], receipt)).toEqual(receipt);
  for (const refs of [
    [],
    [receipt, receipt],
    [{ ...receipt, id: 457 }],
    [{ ...receipt, name: 'foreign' }],
    [{ ...receipt, bytes: 1025 }],
    [{ ...receipt, digest: 'sha256:' + 'd'.repeat(64) }],
  ])
    expect(() => matchSegmentServiceArtifact(refs, receipt)).toThrow('acknowledgement');
});

it('rejects a smaller download byte budget before any storage request and never forwards the GitHub token', async () => {
  const fixture = pipelineActionsFixture();
  const api = new PipelineArtifacts('fixture-token', fixture.identity);
  const [ref] = await api.list();
  const before = fixture.fetch.mock.calls.length;
  await expect(api.archive(ref!, ref!.bytes - 1)).rejects.toThrow('byte budget');
  expect(fixture.fetch.mock.calls.length).toBe(before);
  await expect(api.archive(ref!, ref!.bytes)).resolves.toEqual(fixture.state.zip);
  expect(fixture.state.downloadToken).toBe(false);
  for (const [url, options] of fixture.fetch.mock.calls) {
    expect(options?.redirect).toBe(String(url).endsWith('/zip') ? 'manual' : 'error');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
});

it('fails closed on pre-cancellation before metadata or archive requests', async () => {
  const fixture = pipelineActionsFixture(),
    controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const api = new PipelineArtifacts(
    'fixture-token',
    fixture.identity,
    94,
    'league-segment-service.yml',
    controller.signal,
  );
  await expect(api.authenticateRun()).rejects.toThrow('cancelled');
  await expect(
    api.archive({ id: 456, name: 'unused', bytes: 1, digest: 'sha256:' + 'c'.repeat(64) }),
  ).rejects.toThrow('cancelled');
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it('bounds actual streamed response bytes by the requested share while preserving the old default', async () => {
  await expect(boundedArtifactResponse(new Response(new Uint8Array([1, 2, 3])), 2)).rejects.toThrow(
    'ZIP bound',
  );
  await expect(boundedArtifactResponse(new Response(new Uint8Array([1, 2, 3])))).resolves.toEqual(
    Buffer.from([1, 2, 3]),
  );
  for (const limit of [0, -1, 1.1, NaN, LEAGUE_ARCHIVE_BYTES + 1])
    await expect(boundedArtifactResponse(new Response(new Uint8Array([1])), limit)).rejects.toThrow(
      'budget invalid',
    );
});
