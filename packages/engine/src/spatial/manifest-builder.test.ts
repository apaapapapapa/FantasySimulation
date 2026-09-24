import { expect, it } from 'vite-plus/test';
import { sampleManifest, observedRules } from '@fantasy/samples';
import { ManifestBuilder } from './manifest-builder.ts';
import { prepareBattle, reference } from './prepare.ts';

it('builds the same prepared input, excludes unrelated revisions and owns its snapshot', async () => {
  const manifest = await sampleManifest();
  const policy = manifest.revisions.find((r) => r.kind === 'policy')!;
  const builder = ManifestBuilder.from([...manifest.revisions, { ...policy, id: 'unused-policy' }]);
  const { seed, participants, ruleset, scenario } = manifest;
  const expected = await prepareBattle(manifest);
  policy.definition.movement = 'hold';
  expect(await builder.build({ seed, participants, ruleset, scenario })).toEqual(expected);
  const derived = ManifestBuilder.participants(0, participants);
  expect(derived.map((p) => [p.rngStream, p.rngSeed])).toEqual([
    [0, 2654435769],
    [1, 1013904242],
  ]);
  derived[0].position.x++;
  expect(derived[0].position.x).not.toBe(participants[0].position.x);
});
it('relinks renamed abilities through policy, character and participants without reordering or async mutation', async () => {
  const manifest = await sampleManifest();
  const from = manifest.revisions.find((r) => r.kind === 'ability')!;
  const to = await ManifestBuilder.create('ability', 'renamed-sword', 2, {
    ...from.definition,
    castSteps: 7,
  });
  const order = manifest.revisions.map((r) => r.kind);
  const before = structuredClone(manifest);
  const pending = ManifestBuilder.relink(manifest, [{ from, to }]);
  to.definition.castSteps = 999;
  manifest.participants[0].position.x = 999999;
  const linked = await pending;
  expect(linked.revisions.map((r) => r.kind)).toEqual(order);
  expect(linked.participants[0].position).toEqual(before.participants[0].position);
  const battle = await prepareBattle(linked);
  expect(battle.actors[0].abilities[0]).toMatchObject({
    id: 'renamed-sword',
    revision: 2,
    definition: { castSteps: 7 },
  });
  expect(battle.actors[0].policy.priorities[0]?.abilityId).toBe('renamed-sword');
  expect(linked.participants[0].character.contentHash).not.toBe(
    before.participants[0].character.contentHash,
  );
});
it('rejects invalid content, duplicate replacements and mismatched owned references with typed codes', async () => {
  const manifest = await sampleManifest();
  const from = manifest.revisions.find((r) => r.kind === 'ability')!;
  const to = structuredClone(from);
  to.definition.castSteps++;
  await expect(ManifestBuilder.relink(manifest, [{ from, to }])).rejects.toMatchObject({
    code: 'revision-content',
  });
  await expect(
    ManifestBuilder.relink(manifest, [
      { from, to: from },
      { from, to: from },
    ]),
  ).rejects.toMatchObject({ code: 'duplicate-revision' });
  const character = manifest.revisions.find((r) => r.kind === 'character')!;
  const replacement = await ManifestBuilder.create('character', character.id, 1, {
    ...character.definition,
    abilities: [{ ...reference(from), contentHash: `sha256:${'1'.repeat(64)}` }],
  });
  await expect(
    ManifestBuilder.relink(manifest, [{ from: character, to: replacement }]),
  ).rejects.toMatchObject({ code: 'missing-revision' });
});
it('reports unsupported rules and invalid spawn bounds without matching error text', async () => {
  await expect(
    ManifestBuilder.create('ruleset', 'old-rules', 1, observedRules.definition),
  ).rejects.toMatchObject({ code: 'unsupported-rules' });
  const manifest = await sampleManifest();
  manifest.participants[0].position.x = 50000;
  await expect(ManifestBuilder.from(manifest.revisions).build(manifest)).rejects.toMatchObject({
    code: 'spawn-bounds',
  });
});
it('refuses ambiguous ownership when renaming an ability that has multiple saved revisions', async () => {
  const manifest = await sampleManifest();
  const from = manifest.revisions.find((revision) => revision.kind === 'ability')!;
  manifest.revisions.push({ ...structuredClone(from), revision: 2 });
  const to = await ManifestBuilder.create('ability', 'different-id', 1, from.definition);
  await expect(ManifestBuilder.relink(manifest, [{ from, to }])).rejects.toThrow(/ambiguous/);
  const occupied = { ...to, id: from.id, revision: 2 };
  await expect(ManifestBuilder.relink(manifest, [{ from, to: occupied }])).rejects.toThrow(
    /already owned/,
  );
});
