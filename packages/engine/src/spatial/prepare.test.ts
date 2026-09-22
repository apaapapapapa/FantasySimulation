import { describe, expect, it } from 'vite-plus/test';
import { contentHash, type Revision } from '@fantasy/domain/spatial';
import { sampleManifest } from './sample.ts';
import { prepareBattle, reference, sealRevision } from './prepare.ts';

describe('immutable spatial manifest resolution', () => {
  it('pins all identities, resolves types, preserves the caller and normalizes only revision sets', async () => {
    const input = await sampleManifest();
    const before = structuredClone(input);
    const first = await prepareBattle(input);
    expect(input).toEqual(before);
    expect(first.actors[0].abilities[0]?.id).toBe('sword');
    input.revisions.reverse();
    expect((await prepareBattle(input)).simulationHash).toBe(first.simulationHash);
    input.participants.reverse();
    expect((await prepareBattle(input)).simulationHash).not.toBe(first.simulationHash);
  });
  it.each(['implementationDigest', 'wasmHash', 'angleTableHash', 'physicsProfileHash'] as const)(
    'rejects changed %s',
    async (key) => {
      const input = await sampleManifest();
      input[key] = await contentHash('different');
      await expect(prepareBattle(input)).rejects.toThrow('identity');
    },
  );
  it('rejects a valid-looking hash whose content was changed', async () => {
    const input = await sampleManifest();
    const character = input.revisions.find((r) => r.kind === 'character')!;
    character.definition.stats.hp++;
    await expect(prepareBattle(input)).rejects.toThrow('hash mismatch');
  });
  it('rejects missing, duplicate and mismatched references before execution', async () => {
    const input = await sampleManifest();
    input.revisions = input.revisions.filter((r) => r.kind !== 'ability');
    await expect(prepareBattle(input)).rejects.toThrow('Missing');
    const duplicate = await sampleManifest();
    duplicate.revisions.push(duplicate.revisions[0]!);
    await expect(prepareBattle(duplicate)).rejects.toThrow('Duplicate');
    const mismatch = await sampleManifest();
    mismatch.participants[0].character.revision++;
    await expect(prepareBattle(mismatch)).rejects.toThrow('Missing');
  });
  it('checks unavailable policy abilities and capsule bounds, independently of physics queries', async () => {
    const input = await sampleManifest();
    input.participants[0].position.x = 50000;
    await expect(prepareBattle(input)).rejects.toThrow('bounds');
    const missing = await sampleManifest();
    const old = missing.revisions.find((r) => r.kind === 'policy')!;
    const changed = await sealRevision('policy', old.id, 1, {
      ...old.definition,
      priorities: [{ when: { kind: 'always' }, abilityId: 'missing' }],
    });
    const character = missing.revisions.find((r) => r.kind === 'character')!;
    const updated = await sealRevision('character', character.id, 1, {
      ...character.definition,
      policy: reference(changed),
    });
    missing.revisions = missing.revisions.map((r): Revision =>
      r.kind === 'policy' ? changed : r.kind === 'character' ? updated : r,
    );
    for (const p of missing.participants) p.character = reference(updated);
    await expect(prepareBattle(missing)).rejects.toThrow('unavailable');
  });
});
