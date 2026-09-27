import { OperationError, operationInput } from '@fantasy/api/tooling';
import { join } from 'node:path';
import {
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  PUBLICATION_MAX_BYTES,
  PUBLICATION_MAX_FILES,
  canonicalJson,
  type LeagueUsage,
  type LeagueUsageLease,
} from '@fantasy/domain/spatial';
import { sha256 } from '@fantasy/api/artifacts';
import {
  PublicationS3,
  type R2Config,
  type S3PublicationBudget,
} from '../publication/publication-s3.ts';
import {
  PUBLICATION_CONTROL_BYTES,
  PUBLICATION_CONTROL_KEY,
} from '../publication/publication-files.ts';
import { restorePublication } from '../publication/publication-restore.ts';
import {
  publishPublication,
  type PublishOptions,
  type PublicationStoreFactory,
} from '../publication/publication-remote.ts';
import { admitLeagueUsage } from './league-budget.ts';
import { writeCloudJson } from './league-cloud-files.ts';
import { requireLeagueRestoreBinding } from './league-probe.ts';
import { PublicReadFailure } from '../publication/publication-http.ts';
import { transferTuning, type TransferTuning } from '../publication/publication-io.ts';

export function leagueTransferBudget(
  files: number,
  receipts: number,
  additions: number,
  restore: boolean,
) {
  for (const n of [files, receipts, additions])
    if (!Number.isSafeInteger(n) || n < 0 || n > PUBLICATION_MAX_FILES)
      throw new OperationError('INPUT_INVALID', 'Invalid league transfer counts');
  // Counted transient retries (LEAGUE_TRANSIENT_RETRIES) draw on explicit, bounded headroom.
  const classA = restore ? 1 : additions + 502 + LEAGUE_RETRY_WRITES;
  // Each graph file needs at most a collision GET OR an uncertain-PUT recovery GET.
  // Receipt scans (including orphans) and pointer barriers remain reserved; full-graph HEADs do not.
  const classB = restore
    ? files + 3 + LEAGUE_RETRY_READS
    : receipts + files + 10 + LEAGUE_RETRY_READS;
  const worker = restore ? 0 : 1000;
  return { classA, classB, worker };
}
export const LEAGUE_TRANSIENT_RETRIES = 2;
export const LEAGUE_RETRY_WRITES = 256;
export const LEAGUE_RETRY_READS = 1024;
/**
 * A full league publication writes ~88k small immutable objects, which took about two hours at
 * measured R2 rates (#189); restore keeps the one-hour bound.
 */
export const LEAGUE_RESTORE_DEADLINE_MS = 3_600_000;
export const LEAGUE_PUBLISH_DEADLINE_MS = 10_800_000;
export const leagueTransport = (
  classA: number,
  classB: number,
  deadlineMs = LEAGUE_RESTORE_DEADLINE_MS,
  transientRetries: 0 | 2 = 0,
): S3PublicationBudget => ({
  maxRequests: classA + classB,
  maxClassARequests: classA,
  maxClassBRequests: classB,
  deadlineMs,
  // One SDK attempt keeps the ledger exact; data retries are separate, counted requests.
  maxAttempts: 1,
  transientRetries,
});
export const leagueUsageTotals = (usage: LeagueUsage) => ({
  usedReadRequests: 10000 + usage.leases.reduce((sum, entry) => sum + entry.classB, 0),
  usedWriteRequests: 10000 + usage.leases.reduce((sum, entry) => sum + entry.classA, 0),
});

/** Only this transport boundary receives credentials; durable leases survive failed jobs. */
export async function transferCloudLeague(
  config: R2Config,
  root: string,
  reportRoot: string,
  identity: Pick<LeagueUsageLease, 'id' | 'day' | 'sourceSha'>,
  options?: Pick<PublishOptions, 'viewer' | 'worker' | 'ancestor'>,
  restoreBinding?: { probe: unknown; definition: unknown },
  tuningInput: TransferTuning = {},
) {
  const tuning = transferTuning({ readConcurrency: 32, headConcurrency: 32, ...tuningInput });
  let control: PublicationS3 | undefined;
  const deadline = options ? LEAGUE_PUBLISH_DEADLINE_MS : LEAGUE_RESTORE_DEADLINE_MS;
  const controller = () =>
    (control ??= new PublicationS3(config, leagueTransport(601, 20, deadline), 1));
  let data: PublicationS3 | undefined;
  try {
    if (restoreBinding) {
      if (options)
        throw new OperationError('INPUT_INVALID', 'Restore binding requires restoration');
      await requireLeagueRestoreBinding(
        restoreBinding.probe,
        restoreBinding.definition,
        identity.sourceSha,
        async (key, limit) => {
          const value = await controller().read(key, limit);
          if (!value) throw new PublicReadFailure(404);
          return value.data;
        },
      );
    }
    let inventory: Map<string, number> | undefined;
    let bytes = 0,
      receipts = 0;
    let budget: ReturnType<typeof leagueTransferBudget> | undefined;
    let usage: LeagueUsage | undefined;
    const start = async (graph?: Parameters<PublicationStoreFactory>[0]) => {
      if (!(await controller().readControl())) {
        // A missing ledger is bootstrap only, never permission to reset an existing league.
        const pointer = await controller().read('catalog/current.json', 4000000);
        if (pointer) {
          const current = operationInput(
            () =>
              PublicCatalogCurrentSchema.parse(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pointer.data)),
              ),
            'DATA_INVALID',
          );
          const catalog = await controller().read(
            `catalog/${current.catalogHash.slice(7)}.json`,
            current.bytes,
          );
          if (
            !catalog ||
            catalog.data.length !== current.bytes ||
            sha256(catalog.data) !== current.catalogHash
          )
            throw new OperationError(
              'DATA_INVALID',
              'Cannot bootstrap usage from an unverified catalog',
            );
          if (
            operationInput(
              () =>
                PublicCatalogSchema.parse(
                  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalog.data)),
                ),
              'DATA_INVALID',
            ).leagueWork
          )
            throw new OperationError(
              'DATA_INVALID',
              'Existing league usage ledger is missing; manual recovery required',
            );
        }
        inventory = await controller().inventory();
        if (
          inventory.size >= PUBLICATION_MAX_FILES ||
          [...inventory.values()].reduce((sum, n) => sum + n, 0) + PUBLICATION_CONTROL_BYTES >
            PUBLICATION_MAX_BYTES
        )
          throw new OperationError(
            'BUDGET_EXCEEDED',
            'No capacity for durable league usage ledger',
          );
      }
      await admitLeagueUsage(controller(), {
        ...identity,
        id: identity.id + '-inventory',
        classA: 600,
        classB: 20,
        worker: 0,
      });
      inventory ??= await controller().inventory();
      const listed = new Map(inventory);
      // Reserve the maximum ledger size, including a newly bootstrapped ledger.
      inventory.set(PUBLICATION_CONTROL_KEY, PUBLICATION_CONTROL_BYTES);
      bytes = [...inventory.values()].reduce((sum, n) => sum + n, 0);
      if (bytes > PUBLICATION_MAX_BYTES || inventory.size > PUBLICATION_MAX_FILES)
        throw new OperationError('BUDGET_EXCEEDED', 'League retained capacity exceeded');
      receipts = [...inventory.keys()].filter((key) => key.endsWith('/receipt.json')).length;

      const additions = graph
        ? [...graph.files.keys()].filter(
            (key) => key !== 'catalog/current.json' && !inventory!.has(key),
          ).length + 1
        : 0;
      budget = leagueTransferBudget(
        graph?.files.size ?? inventory.size,
        receipts,
        additions,
        !options,
      );
      usage = await admitLeagueUsage(controller(), {
        ...identity,
        ...budget,
        classB: budget.classB + budget.worker,
      });
      data = new PublicationS3(
        config,
        leagueTransport(budget.classA, budget.classB, deadline, LEAGUE_TRANSIENT_RETRIES),
        tuning.sockets,
      );
      // The lease readback authenticates the new control size without a second full LIST.
      listed.set(PUBLICATION_CONTROL_KEY, Buffer.byteLength(canonicalJson(usage)));
      return { store: data, inventory: listed, etags: controller().listedEtags() };
    };
    const outcome = options
      ? await publishPublication(root, start, {
          ...options,
          maxBytes: PUBLICATION_MAX_BYTES - PUBLICATION_CONTROL_BYTES,
          maxWrites: PUBLICATION_MAX_FILES,
          maxTransferBytes: PUBLICATION_MAX_BYTES,
          maxWorkerRequests: 1000,
          concurrency: 16,
          readConcurrency: tuning.read,
          writeConcurrency: tuning.write,
          headConcurrency: tuning.head,
          maxInFlightBytes: tuning.bytes,
          verificationWorkers: 2,
        })
      : await restorePublication(
          root,
          (await start()).store,
          PUBLICATION_MAX_BYTES,
          tuning.read,
          tuning.bytes,
        );
    if (!budget || !usage || !data || !inventory || !control)
      throw new Error('Publication transport was not started');
    await writeCloudJson(join(reportRoot, identity.id + '.json'), {
      outcome,
      reserved: budget,
      control: control.metrics(),
      transport: data.metrics(),
      month: usage.month,
      sequence: usage.sequence,
      ...leagueUsageTotals(usage),
    });
    return { files: inventory.size, bytes, receipts, ...leagueUsageTotals(usage) };
  } finally {
    console.log(
      JSON.stringify({
        phase: options ? 'publication' : 'restoration',
        control: control?.metrics(),
        transport: data?.metrics(),
      }),
    );
    data?.close();
    control?.close();
  }
}
