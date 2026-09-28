import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { planLeague } from '@fantasy/api/tooling';
import { OperationError, sha256 } from '@fantasy/api/artifacts';
import type { ExecutionSource, LeagueCloudInventorySchema } from '@fantasy/domain/spatial';
import { evidenceGraph, type PublicationEvidence } from '../publication/publication-evidence.ts';
import type { PublicationStore } from '../publication/publication-remote.ts';
import { LEAGUE_PROFILE } from './league-probe.ts';

/** Only recording bytes referenced by this execution's retry/reuse inputs enter the runner archive. */
export async function restoreLeagueRetained(
  evidence: PublicationEvidence,
  definition: unknown,
  source: ExecutionSource,
  inventory: ReturnType<typeof LeagueCloudInventorySchema.parse>,
  store: PublicationStore,
  root: string,
) {
  const graph = evidenceGraph(evidence),
    history = [...(graph.latestWork?.records.values() ?? [])];
  const planned = await planLeague(
    definition,
    source,
    {
      ...LEAGUE_PROFILE,
      retainedBytes: inventory.bytes,
      retainedFiles: inventory.files,
      usedReadRequests: inventory.usedReadRequests,
      usedWriteRequests: inventory.usedWriteRequests,
    },
    history,
    evidence.bundles(),
  );
  const simulations = new Set(
    planned.partitions.flatMap(({ partition }) =>
      partition.slots.map((slot) => slot.simulationHash),
    ),
  );
  const objects = new Set(
    history
      .filter((record) => simulations.has(record.simulationHash))
      .flatMap((record) =>
        record.attempts.flatMap((attempt) => (attempt.objectHash ? [attempt.objectHash] : [])),
      ),
  );
  const files = new Map(
    [...graph.replays.values()]
      .filter((proof) => objects.has(proof.receipt.objectHash))
      .flatMap((proof) => proof.physical.map((file) => [file.key, file] as const)),
  );
  if ([...files.values()].reduce((n, file) => n + file.bytes, 0) > 60 * 1024 ** 2)
    throw new OperationError(
      'BUDGET_EXCEEDED',
      'Retained input requires the legacy bounded workflow',
    );
  for (const file of files.values()) {
    const value = await store.read(file.key, file.bytes);
    if (!value || value.data.length !== file.bytes || sha256(value.data) !== file.checksum)
      throw new OperationError('DATA_INVALID', 'Retained input bytes changed');
    await mkdir(dirname(join(root, file.key)), { recursive: true });
    await writeFile(join(root, file.key), value.data, { flag: 'wx' });
  }
  return { files: files.size, objects: objects.size };
}
