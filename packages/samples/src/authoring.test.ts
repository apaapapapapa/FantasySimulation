import { describe, expect, it } from 'vite-plus/test';
import { revisionReference, type Revision } from '@fantasy/domain/spatial';
import published from '../../../data/spatial/catalog.json' with { type: 'json' };
import builtin from '../../../data/content/builtin-v1.json' with { type: 'json' };
import experimental from '../../../data/content/experimental-p6-foundation-v1.json' with { type: 'json' };
import deflection from '../../../data/content/p6-deflection-v1.json' with { type: 'json' };
import recovery from '../../../data/content/p6-recovery-v1.json' with { type: 'json' };
import teleport from '../../../data/content/p6-teleport-v1.json' with { type: 'json' };
import objects from '../../../data/content/p6-spatial-objects-v1.json' with { type: 'json' };
import phasing from '../../../data/content/p6-phasing-v1.json' with { type: 'json' };
import { compileCatalog } from './authoring.ts';

const sources = [
  ...builtin,
  experimental,
  ...deflection,
  ...recovery,
  ...teleport,
  ...objects,
  ...phasing,
];

const copy = (revision: Revision, id: string) => {
  const { contentHash: _hash, ...document } = structuredClone(revision);
  return { ...document, id };
};

describe('content authoring', () => {
  it('preserves every previously published revision and input bytes', async () => {
    const before = JSON.stringify(sources);
    expect(await compileCatalog(sources)).toEqual(published);
    expect(JSON.stringify(sources)).toBe(before);
    expect(await compileCatalog([...sources].reverse())).toEqual(published);
  });

  it('compiles an independent ability file with a forward named status reference', async () => {
    const existing = await compileCatalog(sources);
    const status = existing.find((r) => r.kind === 'status')!;
    const ability = existing.find((r) => r.kind === 'ability')!;
    const document = {
      ...copy(ability, 'authored-ability'),
      definition: {
        ...ability.definition,
        trigger: 'action',
        target: 'self',
        attack: { kind: 'direct' },
        stages: undefined,
        reaction: undefined,
        effects: [{ kind: 'apply-status', status: { $ref: `status:${status.id}:1` } }],
      },
    };
    // JSON authoring cannot contain JavaScript undefined values.
    const input: unknown = JSON.parse(JSON.stringify(document));
    const result = await compileCatalog([input, ...sources]);
    const added = result.find((r) => r.id === 'authored-ability');
    expect(added?.kind).toBe('ability');
    if (added?.kind !== 'ability') throw new Error('Missing compiled ability');
    expect(added.definition.effects).toEqual([
      { kind: 'apply-status', status: revisionReference(status) },
    ]);
    expect(result.filter((r) => r.id !== added.id)).toEqual(published);
  });

  it.each([
    ['unknown field', (r: Revision) => ({ ...r, unexpected: true })],
    [
      'changed published content',
      (r: Revision) => ({ ...r, definition: { ...r.definition, name: 'changed' } }),
    ],
    [
      'unknown named reference',
      (r: Revision) => ({
        ...copy(r, 'missing'),
        definition: { $ref: 'status:missing:1' },
      }),
    ],
    [
      'mixed named reference',
      (r: Revision) => ({
        ...copy(r, 'mixed'),
        definition: { $ref: 'status:missing:1', extra: 1 },
      }),
    ],
  ] as const)('rejects %s', async (_name, alter) => {
    const existing = await compileCatalog(sources);
    await expect(compileCatalog([alter(existing[0]!)])).rejects.toThrow();
  });

  it('rejects duplicate identities, pinned hash mismatches and cyclic transformations', async () => {
    const existing = await compileCatalog(sources);
    await expect(compileCatalog([...sources, sources[0]])).rejects.toMatchObject({
      code: 'duplicate-revision',
    });
    const base = existing.find((r) => r.kind === 'status')!;
    const cycle = ['cycle-a', 'cycle-b'].map((id, index) => ({
      ...copy(base, id),
      definition: {
        ...base.definition,
        reactions: [
          {
            element: 'fire',
            response: {
              kind: 'transform',
              status: { $ref: `status:cycle-${index ? 'a' : 'b'}:1` },
            },
          },
        ],
      },
    }));
    await expect(compileCatalog(cycle)).rejects.toMatchObject({ code: 'revision-cycle' });
    const ability = existing.find((r) => r.kind === 'ability')!;
    const bad = {
      ...copy(ability, 'pinned'),
      definition: {
        ...ability.definition,
        trigger: 'action',
        target: 'self',
        attack: { kind: 'direct' },
        effects: [
          {
            kind: 'apply-status',
            status: { ...revisionReference(base), contentHash: 'sha256:' + 'f'.repeat(64) },
          },
        ],
      },
    };
    await expect(compileCatalog([...sources, bad])).rejects.toThrow();
  });
});
