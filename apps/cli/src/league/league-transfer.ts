import { OperationError, operationInput } from '@fantasy/api/tooling';
import { join } from 'node:path';
import {
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  PUBLICATION_MAX_BYTES,
  PUBLICATION_MAX_FILES,
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

export function leagueTransferBudget(
  files: number,
  receipts: number,
  additions: number,
  restore: boolean,
) {
  for (const n of [files, receipts, additions])
    if (!Number.isSafeInteger(n) || n < 0 || n > PUBLICATION_MAX_FILES)
      throw new OperationError('INPUT_INVALID', 'Invalid league transfer counts');
  const classA = restore ? 1 : additions + 502;
  const classB = restore ? files + 3 : receipts + 2 * files + 10;
  const worker = restore ? 0 : 1000;
  return { classA, classB, worker };
}
const transport = (classA: number, classB: number): S3PublicationBudget => ({
  maxRequests: classA + classB,
  maxClassARequests: classA,
  maxClassBRequests: classB,
  deadlineMs: 3600000,
  maxAttempts: 1,
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
) {
  const control = new PublicationS3(config, transport(601, 20));
  let data: PublicationS3 | undefined;
  try {
    let inventory: Map<string, number> | undefined;
    if (!(await control.readControl())) {
      // A missing ledger is bootstrap only, never permission to reset an existing league.
      const pointer = await control.read('catalog/current.json', 4000000);
      if (pointer) {
        const current = operationInput(
          () =>
            PublicCatalogCurrentSchema.parse(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pointer.data)),
            ),
          'DATA_INVALID',
        );
        const catalog = await control.read(
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
      inventory = await control.inventory();
      if (
        inventory.size >= PUBLICATION_MAX_FILES ||
        [...inventory.values()].reduce((sum, n) => sum + n, 0) + PUBLICATION_CONTROL_BYTES >
          PUBLICATION_MAX_BYTES
      )
        throw new OperationError('BUDGET_EXCEEDED', 'No capacity for durable league usage ledger');
    }
    await admitLeagueUsage(control, {
      ...identity,
      id: identity.id + '-inventory',
      classA: 600,
      classB: 20,
      worker: 0,
    });
    inventory ??= await control.inventory();
    // Reserve the maximum ledger size, including a newly bootstrapped ledger.
    inventory.set(PUBLICATION_CONTROL_KEY, PUBLICATION_CONTROL_BYTES);
    const bytes = [...inventory.values()].reduce((sum, n) => sum + n, 0);
    if (bytes > PUBLICATION_MAX_BYTES || inventory.size > PUBLICATION_MAX_FILES)
      throw new OperationError('BUDGET_EXCEEDED', 'League retained capacity exceeded');
    const receipts = [...inventory.keys()].filter((key) => key.endsWith('/receipt.json')).length;
    let budget: ReturnType<typeof leagueTransferBudget> | undefined;
    let usage: LeagueUsage | undefined;
    const start = async (graph?: Parameters<PublicationStoreFactory>[0]) => {
      const additions = graph
        ? [...graph.files.keys()].filter(
            (key) => key !== 'catalog/current.json' && !inventory.has(key),
          ).length + 1
        : 0;
      budget = leagueTransferBudget(
        graph?.files.size ?? inventory.size,
        receipts,
        additions,
        !options,
      );
      usage = await admitLeagueUsage(control, {
        ...identity,
        ...budget,
        classB: budget.classB + budget.worker,
      });
      data = new PublicationS3(config, transport(budget.classA, budget.classB));
      return data;
    };
    const outcome = options
      ? await publishPublication(root, start, {
          ...options,
          maxBytes: PUBLICATION_MAX_BYTES - PUBLICATION_CONTROL_BYTES,
          maxWrites: PUBLICATION_MAX_FILES,
          maxTransferBytes: PUBLICATION_MAX_BYTES,
          maxWorkerRequests: 1000,
          concurrency: 16,
        })
      : await restorePublication(root, await start(), PUBLICATION_MAX_BYTES, 16);
    if (!budget || !usage || !data) throw new Error('Publication transport was not started');
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
        control: control.metrics(),
        transport: data?.metrics(),
      }),
    );
    data?.close();
    control.close();
  }
}
