import { afterEach, expect, it, vi } from 'vite-plus/test';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { ManifestBuilder, revisionHash } from '@fantasy/engine/spatial';
import { leagueFixture } from '@fantasy/samples/testing';
import { reference } from '@fantasy/engine/spatial';
import { withMilestonePublication } from '../../test-support/league-milestones.ts';
import { publicationLeagueSource as source } from '../../test-support/leagues.ts';
import { probeLeague, requireLeagueProbeBinding } from './league-probe.ts';
import { prepareCloudLeague } from './league-cloud.ts';
import { PublicReadFailure } from '../publication/publication-http.ts';

afterEach(() => vi.restoreAllMocks());

it('holds a partial published league on identity-only changes before expanding a single slot', async () => {
  await withMilestonePublication(async (f) => {
    await f.update({ ...f.revision, implementationDigest: 'sha256:' + 'f'.repeat(64) });
    const before = [...f.files];
    const build = vi.spyOn(ManifestBuilder.prototype, 'build');
    const held = await probeLeague(f.definition, source.sha, f.read, 'schedule');
    expect(held).toMatchObject({
      needed: false,
      reason: 'engine-milestone-required',
      estimate: null,
      previousIdentity: { implementationDigest: 'sha256:' + 'f'.repeat(64) },
    });
    expect(held.definitionHash).toBe(held.previousDefinitionHash);
    expect(build).not.toHaveBeenCalled();
    expect([...f.files]).toEqual(before);
    await expect(probeLeague(f.definition, source.sha, f.read, 'publish')).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
    });
    expect(build).not.toHaveBeenCalled();
    expect(await probeLeague(f.definition, source.sha, f.read, 'dry-run')).toMatchObject({
      needed: false,
      reason: 'engine-milestone-required',
      estimate: { planned: 4 },
    });
    expect(build).toHaveBeenCalled();
  });
});

it('holds old rules including changed definitions and first publication, but manual publish rejects them', async () => {
  const definition = await leagueFixture(2, 1);
  const rules = definition.revisions.find((r) => r.kind === 'ruleset')!;
  const historical = { ...rules, definition: { ...rules.definition, rulesVersion: 'spatial-v0' } };
  historical.contentHash = await revisionHash(historical);
  definition.ruleset = reference(historical);
  definition.revisions = definition.revisions.map((r) => (r === rules ? historical : r));
  const read = async () => {
    throw new PublicReadFailure(404);
  };
  const build = vi.spyOn(ManifestBuilder.prototype, 'build');
  for (const mode of ['schedule', 'dry-run'] as const)
    expect(
      await probeLeague(
        { ...definition, name: 'new milestone with old rules' },
        source.sha,
        read,
        mode,
      ),
    ).toMatchObject({
      needed: false,
      reason: 'rules-milestone-required',
      estimate: null,
      requests: 1,
    });
  await expect(probeLeague(definition, source.sha, read, 'publish')).rejects.toMatchObject({
    code: 'unsupported-rules',
  });
  expect(build).not.toHaveBeenCalled();
  definition.revisions[0]!.definition.name = 'corrupt';
  await expect(probeLeague(definition, source.sha, read, 'schedule')).rejects.toThrow('content');
});

it('keeps retries for unchanged identity and admits a supported definition milestone', async () => {
  await withMilestonePublication(async (f) => {
    expect(await probeLeague(f.definition, 'b'.repeat(40), f.read, 'schedule')).toMatchObject({
      needed: true,
      estimate: { retries: 4, compute: 4 },
    });
    await f.update({ ...f.revision, implementationDigest: 'sha256:' + 'e'.repeat(64) });
    const next = { ...f.definition, id: 'milestone-two' };
    expect(await probeLeague(next, source.sha, f.read, 'schedule')).toMatchObject({
      needed: true,
      reason: 'initial-publication',
      estimate: { planned: 4 },
    });
    const changed = { ...f.definition, masterSeed: f.definition.masterSeed + 1 };
    expect(await probeLeague(changed, source.sha, f.read, 'publish')).toMatchObject({
      needed: true,
      reason: 'definition-changed',
    });
  });
});

it.each(['checksum', 'missing-child', 'display', 'identity', 'closure', 'denominator'] as const)(
  'never turns invalid historical metadata into a milestone hold: %s',
  async (fault) => {
    await withMilestonePublication(async (f) => {
      const old = { ...f.revision, implementationDigest: 'sha256:' + 'e'.repeat(64) };
      if (fault === 'closure')
        old.definition = {
          ...old.definition,
          revisions: old.definition.revisions.filter((r) => r.kind !== 'policy'),
        };
      await f.update(old, (snapshot) => {
        if (fault === 'display') snapshot.name = 'forged display';
        if (fault === 'identity') snapshot.engineVersion = 'forged-engine';
        if (fault === 'denominator') snapshot.standings.planned++;
      });
      const read = async (key: string) => {
        if (key.startsWith('leagues/') && fault === 'checksum') return Buffer.from('{}');
        if (key.startsWith('leagues/') && fault === 'missing-child')
          throw new PublicReadFailure(404);
        return f.read(key);
      };
      await expect(probeLeague(f.definition, source.sha, read, 'schedule')).rejects.toThrow();
    });
  },
);

it('binds admission to the exact probe and refuses drift before writing reservations', async () => {
  await withMilestonePublication(async (f) => {
    const probe = await probeLeague(f.definition, source.sha, f.read, 'publish');
    expect(() => requireLeagueProbeBinding(probe, probe)).not.toThrow();
    for (const changed of [
      { ...probe, sourceSha: 'c'.repeat(40) },
      { ...probe, catalogHash: null },
      { ...probe, definitionHash: 'sha256:' + 'd'.repeat(64) },
      { ...probe, mode: 'dry-run' },
    ])
      expect(() => requireLeagueProbeBinding(changed, probe)).toThrow('new estimate');
    const output = join(f.root, 'rejected');
    await expect(
      prepareCloudLeague(
        f.definition,
        source,
        'race',
        f.publicRoot,
        output,
        { files: 0, bytes: 0, receipts: 0, usedReadRequests: 0, usedWriteRequests: 0 },
        { ...probe, catalogHash: null },
      ),
    ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
