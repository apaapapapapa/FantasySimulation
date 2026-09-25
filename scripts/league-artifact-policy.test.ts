import { expect, it } from 'vite-plus/test';
import { leagueArtifact } from './league-artifact-policy.ts';
it('binds each download to the current run/attempt name, immutable ID and digest', () => {
  const name = 'league-123-2-input-0',
    digest = 'a'.repeat(64);
  const ref = { id: 1234, name, size: 100, digest };
  expect(leagueArtifact([ref], name, { id: 1234, digest: 'sha256:' + digest })).toEqual({
    id: 1234,
    digest: 'sha256:' + digest,
  });
  for (const entries of [
    [],
    [ref, ref],
    [{ ...ref, name: 'league-123-1-input-0' }],
    [{ ...ref, digest: '' }],
    [{ ...ref, size: 8100000001 }],
  ])
    expect(() => leagueArtifact(entries, name)).toThrow();
  expect(() => leagueArtifact([ref], name, { id: 5678, digest })).toThrow('identity');
  expect(() => leagueArtifact([ref], name, { id: 1234, digest: 'b'.repeat(64) })).toThrow(
    'identity',
  );
});
