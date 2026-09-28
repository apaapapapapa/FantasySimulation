import { join } from 'node:path';
import { OperationError, sha256 } from '@fantasy/api/artifacts';
import {
  PUBLICATION_MAX_BYTES,
  PUBLICATION_MAX_FILES,
  type LeagueUsageLease,
} from '@fantasy/domain/spatial';
import { evidenceGraph, type PublicationEvidence } from '../publication/publication-evidence.ts';
import {
  publicationBytes,
  PUBLICATION_CONTROL_BYTES,
  PUBLICATION_CONTROL_KEY,
} from '../publication/publication-files.ts';
import { PublicationIo } from '../publication/publication-io.ts';
import { publicationPool } from '../publication/publication-pool.ts';
import { PublicationS3, type R2Config } from '../publication/publication-s3.ts';
import type { PublicationStore } from '../publication/publication-remote.ts';
import { admitLeagueUsage } from './league-budget.ts';
import { leagueTransport, LEAGUE_TRANSIENT_RETRIES } from './league-transfer.ts';
import { CHECKPOINT_RESERVE_BYTES } from './league-checkpoint.ts';

/** A single active partition, a bounded payload queue, and an already durably reserved lease. */
export class LeagueStaging {
  private readonly io = new PublicationIo(16, 64 * 1024 ** 2);
  private active = false;
  private failed = false;
  private additions = 0;
  private addedBytes = 0;
  constructor(
    readonly store: PublicationStore,
    readonly inventory: Map<string, number>,
    private readonly maxAddedFiles = 1000,
    private readonly maxAddedBytes = PUBLICATION_MAX_BYTES,
  ) {}
  async stage(evidence: PublicationEvidence, root: string) {
    if (this.active || this.failed)
      throw new OperationError('DATA_INVALID', 'Staging is busy or failed');
    this.active = true;
    try {
      const files = [...evidenceGraph(evidence).files.values()]
        .filter((file) => /^(packs|pack-indexes|sets)\//.test(file.key))
        .map((file) => ({ ...file, source: join(root, file.key) }));
      if (files.length > 4096 || files.reduce((n, file) => n + file.bytes, 0) > 256 * 1024 ** 2)
        throw new OperationError('BUDGET_EXCEEDED', 'Staging partition bound');
      const fresh = files.filter((file) => !this.inventory.has(file.key));
      const bytes = fresh.reduce((n, file) => n + file.bytes, 0);
      if (
        this.additions + fresh.length > this.maxAddedFiles ||
        this.addedBytes + bytes > this.maxAddedBytes ||
        this.inventory.size + fresh.length + 2 > PUBLICATION_MAX_FILES ||
        [...this.inventory.values()].reduce((a, b) => a + b, 0) + bytes + CHECKPOINT_RESERVE_BYTES >
          PUBLICATION_MAX_BYTES
      )
        throw new OperationError('BUDGET_EXCEEDED', 'Staging capacity exceeded before PUT');
      this.additions += fresh.length;
      this.addedBytes += bytes;
      await publicationPool(
        files,
        16,
        (file) =>
          this.io.run(file.bytes, async () => {
            // Re-read and hash the exact bytes sent, even if the path was validated earlier.
            const data = await publicationBytes(file);
            const exact = async () => {
              const stored = await this.store.read(file.key, file.bytes);
              if (
                !stored ||
                stored.data.length !== file.bytes ||
                sha256(stored.data) !== file.checksum
              )
                throw new OperationError('DATA_INVALID', 'Staged immutable bytes mismatch');
            };
            if (this.inventory.has(file.key)) await exact();
            else {
              try {
                await this.store.put(file.key, data, null);
              } catch (error) {
                try {
                  await exact();
                } catch {
                  throw error;
                }
              }
              this.inventory.set(file.key, file.bytes);
            }
          }),
        'league.staging',
      );
      return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.active = false;
    }
  }
  async close() {
    this.failed = true;
    await this.io.close();
  }
  metrics() {
    return { addedFiles: this.additions, addedBytes: this.addedBytes };
  }
}

export async function openLeagueStaging(
  config: R2Config,
  identity: Pick<LeagueUsageLease, 'id' | 'day' | 'sourceSha'>,
) {
  const control = new PublicationS3(config, leagueTransport(601, 20, 3600000), 1);
  let data: PublicationS3 | undefined;
  try {
    if (!(await control.readControl()))
      throw new OperationError('DATA_INVALID', 'Existing durable usage ledger required');
    await admitLeagueUsage(control, {
      ...identity,
      id: identity.id + '-inventory',
      classA: 600,
      classB: 20,
      worker: 0,
    });
    const inventory = await control.inventory();
    inventory.set(PUBLICATION_CONTROL_KEY, PUBLICATION_CONTROL_BYTES);
    // Includes uncertain writes/retries and final pointer/readback headroom. Never refunded.
    const budget = {
      classA: 1800,
      classB: Math.min(1900000, inventory.size * 2 + 10000),
      worker: 1000,
    };
    const usage = await admitLeagueUsage(control, {
      ...identity,
      ...budget,
      classB: budget.classB + budget.worker,
    });
    data = new PublicationS3(
      config,
      leagueTransport(budget.classA, budget.classB, 3600000, LEAGUE_TRANSIENT_RETRIES),
      16,
    );
    const staging = new LeagueStaging(data, inventory);
    return {
      staging,
      store: data,
      inventory,
      usage,
      async close() {
        await staging.close();
        data?.close();
        control.close();
      },
    };
  } catch (error) {
    data?.close();
    control.close();
    throw error;
  }
}
