import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BatchPlanSchema,
  BatchIndexSchema,
  BundleReceiptSchema,
  DEFAULT_BUDGET,
  ResultSchema,
  StoredManifestSchema,
  SpecInputSchema,
  StreamRecordSchema,
  canonicalJson,
  contentHash,
  eventHashLine,
  trajectoryHashLine,
  compareIds,
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  PublicReplaySetSchema,
  PublicMatchPageSchema,
  type BatchPlan,
  type BatchIndex,
} from '@fantasy/domain/spatial';
import recording from '../../../packages/domain/fixtures/replay/mutual-hit.json' with { type: 'json' };
import { ReplayWriter } from '../src/replay-writer.ts';
import { BattleBundles } from '../src/battle-bundle.ts';
import { sha256 } from '../src/replay-files.ts';

/** Saved v1.10 display input; synthetic source/IDs below are fixture data, not delivery evidence. */
export async function publicationFixture(
  root: string,
  kind: 'complete' | 'truncated' | 'unresolved' = 'complete',
) {
  const input = StoredManifestSchema.parse(recording.input),
    result = ResultSchema.parse(recording.result);
  const records = recording.records.map((r) => StreamRecordSchema.parse(r));
  if (kind !== 'complete') {
    const terminal = records.at(-1)!;
    if (terminal.kind !== 'terminal') throw new Error('Fixture terminal missing');
    const outcome =
      kind === 'truncated'
        ? ({ kind, resource: 'events', reason: 'fixture limit' } as const)
        : ({
            kind,
            ruleId: 'fixture.conflict',
            revisions: [] as string[],
            reason: 'fixture conflict',
          } as const);
    terminal.outcome = outcome;
    terminal.events[0]!.ruleId = `battle.${kind}`;
    terminal.events[0]!.reason = outcome.reason;
    result.outcome = outcome;
    result.eventHash = sha256(
      records
        .flatMap((r) => ('events' in r ? r.events : []))
        .map(eventHashLine)
        .join(''),
    );
    result.trajectoryHash = sha256(records.map(trajectoryHashLine).join(''));
  }
  const work = join(root, '.work');
  const writer = await ReplayWriter.create(work, {
    id: 'fixture-replay',
    attemptId: 'fixture-attempt',
    simulationHash: result.simulationHash,
    input,
  });
  for (const record of records) await writer.append(record);
  const manifest = await writer.finish({ kind: 'result', result }, 'fixture-result');
  const manifestBytes = await readFile(join(work, manifest.id, 'manifest.json'));
  const source = {
    sha: 'a'.repeat(40),
    node: '24.19.0',
    platform: 'linux' as const,
    arch: 'x64' as const,
  };
  const body = {
    schemaVersion: 1 as const,
    source,
    simulationHash: result.simulationHash,
    resultId: 'fixture-result',
    attemptId: manifest.attemptId,
    replayId: manifest.id,
    resultHash: sha256(canonicalJson(result)),
    manifestChecksum: sha256(manifestBytes),
    bytes:
      manifestBytes.length +
      [...manifest.chunks, ...manifest.checkpoints].reduce((n, ref) => n + ref.bytes, 0),
    result,
  };
  const receipt = BundleReceiptSchema.parse({ ...body, objectHash: await contentHash(body) });
  const objects = join(root, 'objects'),
    object = join(objects, receipt.objectHash.slice(7));
  await mkdir(objects);
  await rename(join(work, manifest.id), object);
  // Noncanonical whitespace is intentional: export must retain these original bytes.
  await writeFile(join(object, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  const spec = SpecInputSchema.parse({
    seed: input.seed,
    participants: input.participants,
    ruleset: input.ruleset,
    scenario: input.scenario,
  });
  const identity = { key: 'saved-fixture', simulationHash: result.simulationHash };
  const planBody = {
    schemaVersion: 1 as const,
    source,
    engineVersion: input.engineVersion,
    implementationDigest: input.implementationDigest,
    revisions: input.revisions,
    slots: [{ ...identity, id: await contentHash(identity), spec }],
    budget: DEFAULT_BUDGET,
    estimatedBytesPerMatch: 1_000_000,
    maxOutputBytes: 32 * 1024 ** 2,
    maxWorkBytes: 256 * 1024 ** 2,
  };
  const plan = BatchPlanSchema.parse({ ...planBody, id: await contentHash(planBody) });
  const index = await publicationIndex(
    plan,
    plan.slots.map((slot) => ({
      slotId: slot.id,
      simulationHash: slot.simulationHash,
      state: kind,
      receipt,
      reused: false,
      reason: '',
    })),
  );
  return { plan, index, receipt, manifest, object, bundles: new BattleBundles(root) };
}
export async function publicationIndex(
  plan: BatchPlan,
  slots: BatchIndex['slots'],
  shardIndex = 0,
  shardCount = 1,
) {
  const body = {
    schemaVersion: 1 as const,
    planId: plan.id,
    source: plan.source,
    shardIndex,
    shardCount,
    slots,
    complete: slots.every((s) => s.state === 'complete'),
  };
  return BatchIndexSchema.parse({ ...body, id: await contentHash(body) });
}
export async function expandPublicationPlan(plan: BatchPlan, count: number) {
  const slots = [plan.slots[0]!];
  for (let i = 1; i < count; i++) {
    const identity = {
      key: `pending-${i}`,
      simulationHash: await contentHash({ fixture: 'unexecuted-slot', i }),
    };
    slots.push({
      ...identity,
      id: await contentHash(identity),
      spec: { ...slots[0]!.spec, seed: i },
    });
  }
  const { id: _, ...body } = { ...plan, slots: slots.sort((a, b) => compareIds(a.id, b.id)) };
  return { ...body, id: await contentHash(body) };
}
export async function readPublication(root: string) {
  const json = async (path: string): Promise<unknown> =>
    JSON.parse(await readFile(join(root, path), 'utf8'));
  const current = PublicCatalogCurrentSchema.parse(await json('catalog/current.json'));
  const catalog = PublicCatalogSchema.parse(
    await json(`catalog/${current.catalogHash.slice(7)}.json`),
  );
  const sets = await Promise.all(
    catalog.sets.map(async (ref) => {
      const set = PublicReplaySetSchema.parse(await json(`sets/${ref.setHash.slice(7)}/set.json`));
      const pages = await Promise.all(
        set.pages.map(async (page) =>
          PublicMatchPageSchema.parse(
            await json(`sets/${ref.setHash.slice(7)}/${page.pageHash.slice(7)}.json`),
          ),
        ),
      );
      return { ref, set, pages, rows: pages.flatMap((page) => page.rows) };
    }),
  );
  return { current, catalog, sets };
}
