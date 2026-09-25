import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, lstat, open, opendir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { runtimeOwner } from '../db/schema.ts';
import { JobStore } from './job-store.ts';
import { StoreError } from '../db/store.ts';
import { readBoundedFile, GENERATED_UUID } from '../replay/replay-files.ts';

function processAlive(pid: number) {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
/** No stale-directory deletion can race another live coordinator for this database/root. */
export async function ownRuntime(jobs: JobStore, inputRoot: string) {
  const root = resolve(inputRoot),
    token = randomUUID(),
    machine = hostname();
  let created = false,
    adopted = false;
  const owner = jobs.store.transaction(() => {
    const existing = jobs.store.orm.select().from(runtimeOwner).get();
    created = !existing;
    if (
      existing &&
      (existing.artifactRoot !== root ||
        existing.hostname !== machine ||
        processAlive(existing.pid))
    )
      throw new StoreError(
        'unavailable',
        'Database coordinator is active or belongs to another host/artifact root',
      );
    const row = {
      id: 1,
      storeId: existing?.storeId ?? randomUUID(),
      artifactRoot: root,
      hostname: machine,
      pid: process.pid,
      token,
    };
    jobs.store.orm
      .insert(runtimeOwner)
      .values(row)
      .onConflictDoUpdate({ target: runtimeOwner.id, set: row })
      .run();
    return row;
  });
  const release = () =>
    jobs.store.orm
      .update(runtimeOwner)
      .set({ pid: 0 })
      .where(and(eq(runtimeOwner.id, 1), eq(runtimeOwner.token, token)))
      .run();
  try {
    await mkdir(root, { recursive: true });
    if (!(await lstat(root)).isDirectory())
      throw new Error('Artifact root must be a real directory');
    const marker = join(root, '.store-id');
    let hasMarker = false,
      hasOtherEntries = false;
    for await (const entry of await opendir(root)) {
      if (entry.name === '.store-id') hasMarker = true;
      else hasOtherEntries = true;
    }
    if (!hasMarker && hasOtherEntries)
      throw new Error('Refusing to adopt a nonempty unowned artifact root');
    try {
      const file = await open(marker, 'wx');
      try {
        await file.writeFile(owner.storeId);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if ((await readBoundedFile(marker, 100)).toString('utf8') !== owner.storeId)
      throw new Error('Artifact root belongs to another database');
    adopted = true;
    // Only names created by ReplayWriter are eligible; unrelated user files are untouched.
    let removed = 0;
    for await (const entry of await opendir(root)) {
      if (!entry.isDirectory()) continue;
      const staging =
        entry.name.startsWith('.staging-') && GENERATED_UUID.test(entry.name.slice(9));
      const orphan = GENERATED_UUID.test(entry.name) && !jobs.artifact(entry.name);
      if (staging || orphan) {
        await rm(join(root, entry.name), { recursive: true });
        removed++;
      }
    }
    return { root, removed, release };
  } catch (error) {
    if (created && !adopted)
      jobs.store.orm
        .delete(runtimeOwner)
        .where(and(eq(runtimeOwner.id, 1), eq(runtimeOwner.token, token)))
        .run();
    else release();
    throw error;
  }
}
