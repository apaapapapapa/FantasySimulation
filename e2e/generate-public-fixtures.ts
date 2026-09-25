// Explicit fixture preparation only. Static E2E never imports this module or starts an API/DB.
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BatchPlanSchema,
  BundleReceiptSchema,
  DEFAULT_BUDGET,
  ReplayManifestSchema,
  canonicalJson,
  contentHash,
  hashBytes,
} from '@fantasy/domain/spatial';
import { BattleBundles } from '@fantasy/api/artifacts';
import { exportPublication } from '@fantasy/cli/export';
import {
  expandPublicationPlan,
  publicationFixture,
  publicationIndex,
  readPublication,
} from '@fantasy/cli/testing';

import { savePublicFixtures } from './publication-fixtures.ts';

const root = await mkdtemp(join(tmpdir(), 'fantasy-public-fixture-'));
try {
  const [
    saved = 'apps/web/test-fixtures/replays/swordsman-sky-mage-240',
    output = 'apps/web/test-fixtures/publication',
    sourceSha = 'add5a103f1685b3063f452dbdc49f28bc148952b',
    rowCount = '1000',
  ] = process.argv.slice(2);
  const rows = Number(rowCount);
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !Number.isInteger(rows) || rows < 1 || rows > 1000)
    throw new Error('Expected saved directory, output directory, source SHA and 1–1000 rows');
  const manifestBytes = await readFile(join(saved, 'manifest.json'));
  const manifest = ReplayManifestSchema.parse(JSON.parse(manifestBytes.toString()));
  if (manifest.end.kind !== 'result') throw new Error('Expected fixed complete recording');
  const source = {
    sha: sourceSha,
    node: '24.19.0',
    platform: 'linux' as const,
    arch: 'x64' as const,
  };
  const result = manifest.end.result;
  const body = {
    schemaVersion: 1 as const,
    source,
    simulationHash: manifest.simulationHash,
    resultId: manifest.resultId,
    attemptId: manifest.attemptId,
    replayId: manifest.id,
    resultHash: await contentHash(result),
    manifestChecksum: await hashBytes(manifestBytes),
    bytes:
      manifestBytes.length +
      [...manifest.chunks, ...manifest.checkpoints].reduce((sum, r) => sum + r.bytes, 0),
    result,
  };
  const receipt = BundleReceiptSchema.parse({ ...body, objectHash: await contentHash(body) });
  const bundlesRoot = join(root, 'saved');
  const object = join(bundlesRoot, 'objects', receipt.objectHash.slice(7));
  await mkdir(object, { recursive: true });
  await cp(saved, object, { recursive: true });
  await writeFile(join(object, 'receipt.json'), canonicalJson(receipt) + '\n');
  const identity = {
    key: `saved-${manifest.lastVerifiedStep}`,
    simulationHash: manifest.simulationHash,
  };
  const { seed, participants, ruleset, scenario } = manifest.input;
  const planBody = {
    schemaVersion: 1 as const,
    source,
    engineVersion: manifest.input.engineVersion,
    implementationDigest: manifest.input.implementationDigest,
    revisions: manifest.input.revisions,
    slots: [
      {
        ...identity,
        id: await contentHash(identity),
        spec: { seed, participants, ruleset, scenario },
      },
    ],
    budget: DEFAULT_BUDGET,
    estimatedBytesPerMatch: 1000000,
    maxOutputBytes: 32000000,
    maxWorkBytes: 256 * 1024 ** 2,
  };
  const plan = BatchPlanSchema.parse(
    await expandPublicationPlan(
      BatchPlanSchema.parse({ ...planBody, id: await contentHash(planBody) }),
      rows,
    ),
  );
  const index = await publicationIndex(
    plan,
    plan.slots.map((slot, i) => ({
      slotId: slot.id,
      simulationHash: slot.simulationHash,
      state: slot.key === identity.key ? 'complete' : i % 2 ? 'pending' : 'failed',
      receipt: slot.key === identity.key ? receipt : null,
      reused: false,
      reason: slot.key === identity.key ? '' : 'Synthetic unexecuted fixture slot',
    })),
  );
  const published = join(root, 'published');
  await exportPublication(plan, [{ index, bundles: new BattleBundles(bundlesRoot) }], published);
  for (const kind of (rows === 1
    ? ['complete', 'unresolved', 'truncated']
    : ['unresolved', 'truncated']) as ('complete' | 'unresolved' | 'truncated')[]) {
    const fixture = await publicationFixture(
      join(root, kind),
      kind,
      kind === 'unresolved' ? 8001 : kind === 'truncated' ? 8002 : 8003,
    );
    await exportPublication(
      fixture.plan,
      [{ index: fixture.index, bundles: fixture.bundles }],
      published,
    );
  }
  const data = await readPublication(published);
  const fixtures = data.sets.map(({ ref, set, pages }) => ({
    setHash: ref.setHash,
    totalRows: set.totalRows,
    rows: pages.flatMap((page) =>
      page.rows
        .filter((r) => r.replay)
        .map((row) => ({
          page: page.index,
          slotId: row.slotId,
          state: row.state,
          replay: row.replay,
        })),
    ),
  }));
  await savePublicFixtures(published, output, {
    source,
    generator: 'e2e/generate-public-fixtures.ts via exportPublication',
    policy: `Saved ${manifest.lastVerifiedStep}-step replay bytes are unchanged. Additional mutual-hit/partial endings and unexecuted rows are display fixtures, not new engine correctness evidence. Regeneration requires review.`,
    fixtures,
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
