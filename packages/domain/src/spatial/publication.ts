import { z } from 'zod';
import { canonicalJson } from './canonical.ts';
import {
  BudgetSchema,
  CharacterSchema,
  HashSchema,
  IdSchema,
  ParticipantSchema,
  RefSchema,
} from './contracts.ts';
import { SpecInputSchema } from './api.ts';
import { BatchSlotResultSchema, BundleReceiptSchema, ExecutionSourceSchema } from './batch.ts';
import { ResultSchema } from './records.ts';
import { ReplayManifestSchema, type ReplayManifest } from './replay.ts';
import { LeagueFileRefSchema, PublicLeagueCatalogRefSchema } from './league/publication.ts';
export { PUBLICATION_MAX_BYTES, PUBLICATION_MAX_FILES } from './publication/index.ts';

export const PUBLIC_PAGE_ROWS = 100;
export const MAX_PUBLIC_JSON_BYTES = 4_000_000;
const count = z.number().int().min(0).max(1000);
const bytes = z.number().int().min(1).max(MAX_PUBLIC_JSON_BYTES);
const namedRevision = RefSchema.extend({ name: CharacterSchema.shape.name });
const participant = ParticipantSchema.extend({
  character: namedRevision,
});
export const PublicReplayRefSchema = BundleReceiptSchema.pick({
  objectHash: true,
  simulationHash: true,
  resultId: true,
  attemptId: true,
  replayId: true,
  manifestChecksum: true,
}).extend({ receiptChecksum: HashSchema, receiptBytes: z.number().int().min(1).max(65536) });
export type PublicReplayRef = z.infer<typeof PublicReplayRefSchema>;
export const PublicMatchRowSchema = z
  .strictObject({
    slotId: BatchSlotResultSchema.shape.slotId,
    simulationHash: BatchSlotResultSchema.shape.simulationHash,
    participants: z.tuple([participant, participant]),
    scenario: namedRevision,
    ruleset: RefSchema,
    seed: SpecInputSchema.shape.seed,
    state: BatchSlotResultSchema.shape.state,
    reused: BatchSlotResultSchema.shape.reused,
    reason: z.enum([
      'verified-result',
      'recorded-unresolved',
      'recorded-truncated',
      'execution-failed',
      'not-started',
      'missing-shard',
    ]),
    result: ResultSchema.pick({ outcome: true, steps: true }).nullable(),
    replay: PublicReplayRefSchema.nullable(),
    playback: z.enum(['full', 'partial', 'unavailable']),
    lastVerifiedStep: ReplayManifestSchema.shape.lastVerifiedStep,
    records: ReplayManifestSchema.shape.records,
  })
  .superRefine((row, ctx) => {
    const kind = row.result?.outcome.kind;
    const recorded = ['complete', 'unresolved', 'truncated'].includes(row.state);
    const expectedReason = {
      complete: 'verified-result',
      unresolved: 'recorded-unresolved',
      truncated: 'recorded-truncated',
      failed: 'execution-failed',
      pending: 'not-started',
    }[row.state];
    if (
      (row.reused && row.state !== 'complete') ||
      recorded !== (row.replay !== null && row.result !== null) ||
      (!recorded &&
        (row.replay !== null ||
          row.result !== null ||
          row.records !== 0 ||
          row.lastVerifiedStep !== null)) ||
      (recorded &&
        (row.records === 0 ||
          row.lastVerifiedStep !== row.result?.steps ||
          row.replay?.simulationHash !== row.simulationHash)) ||
      (row.state === 'complete'
        ? kind !== 'win' && kind !== 'draw'
        : recorded && kind !== row.state) ||
      row.playback !== (row.state === 'complete' ? 'full' : recorded ? 'partial' : 'unavailable') ||
      (row.reason !== expectedReason &&
        !(row.state === 'pending' && row.reason === 'missing-shard')) ||
      row.participants[0].actorId === row.participants[1].actorId ||
      row.participants[0].rngStream === row.participants[1].rngStream ||
      (kind === 'win' &&
        !row.participants.some(
          (p) => row.result?.outcome.kind === 'win' && p.actorId === row.result.outcome.winner,
        ))
    )
      ctx.addIssue({ code: 'custom', message: 'Public row state/result/replay binding mismatch' });
  });
export type PublicMatchRow = z.infer<typeof PublicMatchRowSchema>;
export const PublicMatchPageSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    planId: HashSchema,
    index: z.number().int().min(0).max(9),
    rows: z.array(PublicMatchRowSchema).min(1).max(PUBLIC_PAGE_ROWS),
  })
  .superRefine((page, ctx) => {
    if (page.rows.some((row, i) => i > 0 && page.rows[i - 1]!.slotId >= row.slotId))
      ctx.addIssue({
        code: 'custom',
        message: 'Public rows must be unique and ordered by slot ID',
      });
  });
export type PublicMatchPage = z.infer<typeof PublicMatchPageSchema>;
export const PublicStateCountsSchema = z.strictObject({
  complete: count,
  failed: count,
  unresolved: count,
  truncated: count,
  pending: count,
});
export const PublicReplaySetSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    planId: HashSchema,
    source: ExecutionSourceSchema,
    engineVersion: IdSchema,
    implementationDigest: HashSchema,
    budget: BudgetSchema,
    totalRows: count.min(1),
    incompleteRows: count,
    counts: PublicStateCountsSchema,
    pages: z
      .array(
        z.strictObject({
          index: z.number().int().min(0).max(9),
          pageHash: HashSchema,
          bytes,
          rows: count.min(1).max(PUBLIC_PAGE_ROWS),
        }),
      )
      .min(1)
      .max(10),
  })
  .superRefine((set, ctx) => {
    if (
      Object.values(set.counts).reduce((a, b) => a + b, 0) !== set.totalRows ||
      set.incompleteRows !== set.totalRows - set.counts.complete ||
      set.pages.length !== Math.ceil(set.totalRows / PUBLIC_PAGE_ROWS) ||
      new Set(set.pages.map((page) => page.pageHash)).size !== set.pages.length ||
      set.pages.some(
        (page, i) =>
          page.index !== i ||
          page.rows !== Math.min(PUBLIC_PAGE_ROWS, set.totalRows - i * PUBLIC_PAGE_ROWS),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Public set count/page mismatch' });
  });
export type PublicReplaySet = z.infer<typeof PublicReplaySetSchema>;
export const PublicCatalogSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    previousCatalogHash: HashSchema.nullable(),
    leagues: z.array(PublicLeagueCatalogRefSchema).max(1000).optional(),
    leagueWork: LeagueFileRefSchema.optional(),
    sets: z.array(z.strictObject({ setHash: HashSchema, bytes })).max(1000),
  })
  .superRefine((catalog, ctx) => {
    if (catalog.sets.length === 0 && !catalog.leagueWork)
      ctx.addIssue({
        code: 'custom',
        message: 'An empty replay catalog requires a durable league journal',
      });
    if (catalog.sets.some((set, i) => i > 0 && catalog.sets[i - 1]!.setHash >= set.setHash))
      ctx.addIssue({ code: 'custom', message: 'Catalog sets must be unique and ordered by hash' });
    if (catalog.leagues?.some((league, i) => i > 0 && catalog.leagues![i - 1]!.id >= league.id))
      ctx.addIssue({ code: 'custom', message: 'Catalog leagues must be unique and ordered by ID' });
  });
export type PublicCatalog = z.infer<typeof PublicCatalogSchema>;
export const PublicCatalogCurrentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  catalogHash: HashSchema,
  bytes,
});
export type PublicCatalogCurrent = z.infer<typeof PublicCatalogCurrentSchema>;

/** JSON hashes address the entire decoded UTF-8 file, with no embedded self-hash. */
export const publicHashName = (hash: string) => HashSchema.parse(hash).slice(7);
export const PublicKeySchema = z
  .string()
  .regex(
    /^(?:catalog\/(?:current|[0-9a-f]{64})\.json|leagues\/[0-9a-f]{64}\.json|sets\/[0-9a-f]{64}\/(?:set|[0-9a-f]{64})\.json|objects\/[0-9a-f]{64}\/(?:receipt\.json|manifest\.json|chunk-[0-9]{5}\.ndjson\.gz|checkpoint-[0-9]{5}\.json\.gz))$/,
  );

/** A transport must verify receipt/manifest bytes before using this reference check. */
export function assertPublicReplayBinding(
  row: PublicMatchRow,
  receiptInput: unknown,
  manifest: ReplayManifest,
) {
  const receipt = BundleReceiptSchema.parse(receiptInput);
  const ref = row.replay;
  const named = (kind: 'character' | 'scenario', value: z.infer<typeof namedRevision>) =>
    manifest.input.revisions.some(
      (r) =>
        r.kind === kind &&
        r.id === value.id &&
        r.revision === value.revision &&
        r.contentHash === value.contentHash &&
        r.definition.name === value.name,
    );
  if (
    !ref ||
    Object.entries(ref).some(
      ([key, value]) =>
        key !== 'receiptChecksum' &&
        key !== 'receiptBytes' &&
        receipt[key as keyof typeof receipt] !== value,
    ) ||
    !row.participants.every((p) => named('character', p.character)) ||
    !named('scenario', row.scenario) ||
    manifest.simulationHash !== row.simulationHash ||
    manifest.id !== ref.replayId ||
    manifest.resultId !== ref.resultId ||
    manifest.attemptId !== ref.attemptId ||
    manifest.end.kind !== 'result' ||
    canonicalJson(manifest.end.result) !== canonicalJson(receipt.result) ||
    canonicalJson(row.result) !==
      canonicalJson({ outcome: receipt.result.outcome, steps: receipt.result.steps }) ||
    row.records !== manifest.records ||
    row.lastVerifiedStep !== manifest.lastVerifiedStep ||
    canonicalJson({
      seed: row.seed,
      participants: row.participants.map((p) => ({
        ...p,
        character: RefSchema.parse({
          id: p.character.id,
          revision: p.character.revision,
          contentHash: p.character.contentHash,
        }),
      })),
      scenario: RefSchema.parse({
        id: row.scenario.id,
        revision: row.scenario.revision,
        contentHash: row.scenario.contentHash,
      }),
      ruleset: row.ruleset,
    }) !==
      canonicalJson({
        seed: manifest.input.seed,
        participants: manifest.input.participants,
        scenario: manifest.input.scenario,
        ruleset: manifest.input.ruleset,
      })
  )
    throw new Error('Public row/receipt/manifest reference mismatch');
}

export function assertPublicPageBinding(set: PublicReplaySet, page: PublicMatchPage) {
  const ref = set.pages[page.index];
  if (!ref || page.planId !== set.planId || page.rows.length !== ref.rows)
    throw new Error('Public set/page reference mismatch');
}
