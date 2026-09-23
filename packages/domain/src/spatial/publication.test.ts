import { describe, expect, it } from 'vite-plus/test';
import {
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  PublicMatchPageSchema,
  PublicMatchRowSchema,
  PublicReplaySetSchema,
  PublicKeySchema,
  type PublicMatchRow,
} from './publication.ts';
import { DEFAULT_BUDGET, StoredManifestSchema } from './contracts.ts';
import recording from '../../fixtures/replay/mutual-hit.json' with { type: 'json' };

const hash = (n: number) => 'sha256:' + n.toString(16).padStart(64, '0');
function pendingRow(): PublicMatchRow {
  const input = StoredManifestSchema.parse(recording.input);
  return {
    slotId: hash(1),
    simulationHash: hash(2),
    participants: input.participants.map((p) => ({
      ...p,
      character: { ...p.character, name: p.actorId },
    })) as PublicMatchRow['participants'],
    scenario: { ...input.scenario, name: 'field' },
    ruleset: input.ruleset,
    seed: input.seed,
    state: 'pending',
    reused: false,
    reason: 'not-started',
    result: null,
    replay: null,
    playback: 'unavailable',
    records: 0,
    lastVerifiedStep: null,
  };
}
function publicSet() {
  return {
    schemaVersion: 1,
    planId: hash(3),
    source: { sha: 'b'.repeat(40), node: '24.19.0', platform: 'linux', arch: 'x64' },
    engineVersion: 'spatial-v1.10',
    implementationDigest: hash(4),
    budget: DEFAULT_BUDGET,
    totalRows: 1,
    incompleteRows: 1,
    counts: { complete: 0, failed: 0, unresolved: 0, truncated: 0, pending: 1 },
    pages: [{ index: 0, pageHash: hash(5), bytes: 1000, rows: 1 }],
  };
}

describe('public layout contract v1', () => {
  it('rejects unknown versions and extra fields for each document', () => {
    const documents = [
      [PublicCatalogCurrentSchema, { schemaVersion: 1, catalogHash: hash(1), bytes: 100 }],
      [
        PublicCatalogSchema,
        { schemaVersion: 1, previousCatalogHash: null, sets: [{ setHash: hash(2), bytes: 1000 }] },
      ],
      [PublicReplaySetSchema, publicSet()],
      [
        PublicMatchPageSchema,
        { schemaVersion: 1, planId: hash(3), index: 0, rows: [pendingRow()] },
      ],
    ] as const;
    for (const [schema, value] of documents) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
      expect(schema.safeParse({ ...value, credentials: 'private' }).success).toBe(false);
    }
  });
  it('does not permit invented replay/result IDs or playback on an unrecorded row', () => {
    const row = pendingRow();
    expect(PublicMatchRowSchema.safeParse(row).success).toBe(true);
    for (const patch of [
      { playback: 'full' },
      { reused: true },
      { records: 1 },
      { lastVerifiedStep: 0 },
      { state: 'complete' },
      { result: { outcome: { kind: 'win', winner: 'left' }, steps: 1 } },
      { reason: 'raw failure' },
    ])
      expect(PublicMatchRowSchema.safeParse({ ...row, ...patch }).success).toBe(false);
  });
  it('bounds page rows and requires stable unique ascending slot IDs', () => {
    const page = {
      schemaVersion: 1,
      planId: hash(3),
      index: 0,
      rows: Array.from({ length: 100 }, (_, i) => ({ ...pendingRow(), slotId: hash(i + 1) })),
    };
    expect(PublicMatchPageSchema.safeParse(page).success).toBe(true);
    for (const rows of [
      [],
      [...page.rows, pendingRow()],
      [pendingRow(), pendingRow()],
      [...page.rows].reverse(),
    ])
      expect(PublicMatchPageSchema.safeParse({ ...page, rows }).success).toBe(false);
  });
  it('rejects inconsistent state totals, page order, page lengths and duplicate catalog sets', () => {
    const set = publicSet();
    for (const patch of [
      { totalRows: 2 },
      { incompleteRows: 0 },
      { counts: { ...set.counts, failed: 1 } },
      { pages: [{ ...set.pages[0], index: 1 }] },
      { pages: [{ ...set.pages[0], rows: 2 }] },
    ])
      expect(PublicReplaySetSchema.safeParse({ ...set, ...patch }).success).toBe(false);
    const ref = { setHash: hash(1), bytes: 100 };
    expect(
      PublicCatalogSchema.safeParse({
        schemaVersion: 1,
        previousCatalogHash: null,
        sets: [ref, ref],
      }).success,
    ).toBe(false);
  });
  it.each([
    '../catalog/current.json',
    '/catalog/current.json',
    'https://example.com/catalog/current.json',
    'objects/all',
    'objects/' + 'a'.repeat(64) + '/.env',
    'sets/' + 'b'.repeat(64) + '/0.json',
    'objects/' + 'a'.repeat(64) + '/chunk-00000.json.gz',
  ])('rejects non-layout key %s', (key) => {
    expect(PublicKeySchema.safeParse(key).success).toBe(false);
  });
});
