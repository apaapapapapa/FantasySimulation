import { expect, it } from 'vite-plus/test';
import fixture from '../../fixtures/replay/mutual-hit.json' with { type: 'json' };
import { contentHash } from './canonical.ts';
import { RevisionSchema, type Revision } from './contracts.ts';
import { RecordedManifestSchema } from './replay.ts';
import { replayContext } from './replay-state.ts';
import {
  resolveClosure,
  revisionIndex,
  revisionReference,
  revisionHash,
  type RevisionDependency,
} from './revision-graph.ts';

function graph() {
  const policy = RecordedManifestSchema.parse(fixture.input).revisions.find(
    (revision) => revision.kind === 'policy',
  )!;
  const nodes = ['root', 'child', 'leaf'].map((id) => ({ ...structuredClone(policy), id }));
  const edge = (i: number): RevisionDependency => ({
    kind: 'policy',
    ref: revisionReference(nodes[i]!),
  });
  return { nodes, edge, get: revisionIndex(nodes) };
}
it('preserves discovery and dependency order, and enforces the exact closure bound', () => {
  const { nodes, edge, get } = graph();
  const dependencies = (revision: Revision) =>
    revision.id === 'root' ? [edge(1), edge(2)] : revision.id === 'child' ? [edge(2)] : [];
  expect(resolveClosure([nodes[0]!], get, 3, { dependencies }).map((r) => r.id)).toEqual([
    'root',
    'child',
    'leaf',
  ]);
  expect(
    resolveClosure([nodes[0]!], get, 3, { dependencies, order: 'dependencies-first' }).map(
      (r) => r.id,
    ),
  ).toEqual(['leaf', 'child', 'root']);
  for (const limit of [0, 2])
    expect(() => resolveClosure([nodes[0]!], get, limit, { dependencies })).toThrow(/exceeds/);
});
it('checks every incoming hash even after a node was visited, and refuses duplicate identities', () => {
  const { nodes, edge, get } = graph();
  const bad = edge(1);
  bad.ref.contentHash = `sha256:${'f'.repeat(64)}`;
  expect(() =>
    resolveClosure([nodes[0]!], get, 3, {
      dependencies: (revision) => (revision.id === 'root' ? [edge(1), bad] : []),
    }),
  ).toThrow(/mismatched/);
  expect(() => revisionIndex([nodes[0]!, nodes[0]!])).toThrow(/Duplicate/);
});
it('bounds cyclic discovery and refuses cycles when bottom-up sealing is required', () => {
  const { nodes, edge, get } = graph();
  const dependencies = () => [edge(0)];
  expect(resolveClosure([nodes[0]!], get, 1, { dependencies })).toHaveLength(1);
  expect(() =>
    resolveClosure([nodes[0]!], get, 1, { dependencies, order: 'dependencies-first' }),
  ).toThrow(/cyclic/);
});
it('preserves replay v1 acceptance of an unreferenced status with a missing transform target', async () => {
  const manifest = RecordedManifestSchema.parse(fixture.input);
  const status = RevisionSchema.parse({
    kind: 'status',
    id: 'legacy-transform',
    revision: 1,
    schemaVersion: 1,
    contentHash: `sha256:${'0'.repeat(64)}`,
    definition: {
      name: 'legacy',
      originalText: '',
      stackKey: 'legacy',
      stacking: 'refresh',
      maxStacks: 1,
      durationSteps: 10,
      modifiers: { attack: 0, defense: 0, speedBps: 10000, flight: false, rooted: false },
      periodic: [],
      reactions: [
        {
          element: 'water',
          response: {
            kind: 'transform',
            status: { id: 'absent', revision: 1, contentHash: `sha256:${'1'.repeat(64)}` },
          },
        },
      ],
    },
  });
  status.contentHash = await revisionHash(status);
  manifest.revisions.push(status);
  await expect(replayContext(manifest, await contentHash(manifest))).resolves.toBeDefined();
  expect(() => resolveClosure(manifest.revisions, revisionIndex(manifest.revisions))).toThrow(
    /Missing/,
  );
});
