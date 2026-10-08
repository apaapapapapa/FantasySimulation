import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_SKILL_CATALOG_REFERENCE,
  canonicalJson,
  skillCatalogDigest,
  type SkillCatalog,
} from '@fantasy/domain';
import { readSampleRevisions } from './store.ts';
import {
  assembleSkillCatalogReleases,
  type SkillCatalogRelease,
} from './skill-catalog-releases.ts';
import {
  STARTUP_SKILL_CATALOG_RELEASES,
  readStartupSkillCatalogs,
} from './startup-skill-catalog.ts';
import history from '../../fixtures/skill-catalog-history-signatures.json' with { type: 'json' };

const historical = readStartupSkillCatalogs(readSampleRevisions()),
  previous = historical.at(-1)!,
  changedNode = previous.nodes.find(({ id }) => id === 'skill.sword.rat.1')!,
  next: Extract<SkillCatalogRelease, { kind: 'delta' }> = {
    kind: 'delta',
    reference: {
      id: 'skill-catalog-v1',
      revision: 11,
      // Calculated from the captured unchanged-main v10 with this one test-only name edit.
      contentHash: 'sha256:b47d1efeda27a4c3af9c0287af8e53ac9dceb70f5b7251f3e904c48365e04d1e',
    },
    parent: STARTUP_SKILL_CATALOG_RELEASES.at(-1)!.reference,
    changedNodeIds: ['skill.sword.rat.1'],
    changes: [
      {
        nodeId: 'skill.sword.rat.1',
        node: { ...changedNode, name: 'Test-only catalog release' },
      },
    ],
  };

function append(release: SkillCatalogRelease) {
  return assembleSkillCatalogReleases([...STARTUP_SKILL_CATALOG_RELEASES, release]);
}

function replaceNextNode(node: unknown): SkillCatalogRelease {
  return { ...next, changes: [{ nodeId: 'skill.sword.rat.1', node }] };
}

function digestOrder(catalog: SkillCatalog) {
  return createHash('sha256')
    .update(JSON.stringify(catalog.nodes.map(({ id }) => id)))
    .digest('hex');
}

describe('immutable startup catalog release ledger', () => {
  it.each(history.signatures)(
    'preserves independently captured v$revision bytes, identity, lifecycle and raw node order',
    async (signature) => {
      const catalog = historical.find(({ revision }) => revision === signature.revision)!;
      expect(await skillCatalogDigest(catalog)).toBe(signature.contentHash);
      expect(Buffer.byteLength(canonicalJson(catalog))).toBe(signature.canonicalBytes);
      expect(createHash('sha256').update(canonicalJson(catalog)).digest('hex')).toBe(
        signature.canonicalHash,
      );
      expect(digestOrder(catalog)).toBe(signature.nodeOrderHash);
      expect(
        Object.fromEntries(
          ['available', 'implemented', 'draft', 'retired'].map((state) => [
            state,
            catalog.nodes.filter(({ lifecycle }) => lifecycle === state).length,
          ]),
        ),
      ).toEqual(signature.lifecycle);
    },
  );

  it('adds a test-only next release without changing historical catalogs or other nodes', async () => {
    const assembled = append(next),
      candidate = assembled.at(-1)!;
    expect(assembled.slice(0, -1)).toEqual(historical);
    expect(
      candidate.nodes
        .filter((node, index) => canonicalJson(node) !== canonicalJson(previous.nodes[index]))
        .map(({ id }) => id),
    ).toEqual(['skill.sword.rat.1']);
    expect(await skillCatalogDigest(candidate)).toBe(next.reference.contentHash);
    expect(STARTUP_SKILL_CATALOG_RELEASES).toHaveLength(10);
    expect(STARTUP_SKILL_CATALOG_RELEASES.at(-1)!.reference).toEqual(
      DEFAULT_SKILL_CATALOG_REFERENCE,
    );
    expect(Object.isFrozen(STARTUP_SKILL_CATALOG_RELEASES[0]!.changedNodeIds)).toBe(true);
    candidate.nodes[0]!.name = 'Caller mutation';
    expect(readStartupSkillCatalogs(readSampleRevisions())).toEqual(historical);
  });

  it.each([
    {
      name: 'wrong parent hash',
      release: { ...next, parent: { ...next.parent!, contentHash: `sha256:${'0'.repeat(64)}` } },
      code: 'invalid-parent',
    },
    {
      name: 'repeated revision',
      release: STARTUP_SKILL_CATALOG_RELEASES.at(-1)!,
      code: 'duplicate-revision',
    },
    {
      name: 'missing changed node declaration',
      release: { ...next, changedNodeIds: [] },
      code: 'undeclared-change',
    },
    {
      name: 'duplicate changed node declaration',
      release: { ...next, changedNodeIds: ['skill.sword.rat.1', 'skill.sword.rat.1'] },
      code: 'undeclared-change',
    },
    {
      name: 'changed name with old expected content',
      release: replaceNextNode({ ...changedNode, name: 'Unexpected name' }),
      code: 'content-mismatch',
    },
    {
      name: 'changed recipe with old expected content',
      release: replaceNextNode({
        ...changedNode,
        resolution: previous.nodes.find(({ id }) => id === 'skill.sword.rat.2')!.resolution,
      }),
      code: 'content-mismatch',
    },
    {
      name: 'changed coordinate',
      release: replaceNextNode({
        ...changedNode,
        coordinate: { path: 'judo', zodiac: 'rat', dan: 1 },
      }),
      code: 'invalid-node',
    },
    {
      name: 'changed node ID',
      release: replaceNextNode({ ...changedNode, id: 'skill.sword.rat.2' }),
      code: 'invalid-node',
    },
    {
      name: 'unlisted extra replacement',
      release: {
        ...next,
        changes: [
          ...next.changes,
          {
            nodeId: previous.nodes[0]!.id,
            node: { ...previous.nodes[0]!, name: 'Undeclared edit' },
          },
        ],
      },
      code: 'undeclared-change',
    },
    {
      name: 'duplicate replacement',
      release: { ...next, changes: [...next.changes, ...next.changes] },
      code: 'invalid-node',
    },
  ])('rejects $name', ({ release, code }) => {
    expect(() => append(release as SkillCatalogRelease)).toThrow(expect.objectContaining({ code }));
  });

  it('rejects different content at an existing immutable revision even without a duplicate entry', () => {
    const last = STARTUP_SKILL_CATALOG_RELEASES.at(-1)!;
    if (last.kind !== 'delta') throw new Error('Expected historical delta');
    const catalog = historical.at(-1)!,
      node = catalog.nodes.find(({ id }) => id === last.changedNodeIds[0])!;
    expect(() =>
      assembleSkillCatalogReleases([
        ...STARTUP_SKILL_CATALOG_RELEASES.slice(0, -1),
        {
          ...last,
          changes: [{ nodeId: node.id, node: { ...node, name: 'Rewritten published content' } }],
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'content-mismatch' }));
  });

  it('rejects undeclared historical checkpoint edits', () => {
    const releases = [...STARTUP_SKILL_CATALOG_RELEASES],
      checkpoint = releases[1]!;
    if (checkpoint.kind !== 'historical-snapshot')
      throw new Error('Expected historical checkpoint');
    const catalog = structuredClone(historical[1]!);
    catalog.nodes.find(({ id }) => id === 'skill.illusion-curse.rat.1')!.name =
      'Undeclared checkpoint change';
    releases[1] = { ...checkpoint, catalog };
    expect(() => assembleSkillCatalogReleases(releases)).toThrow(
      expect.objectContaining({ code: 'undeclared-change' }),
    );
  });
});
