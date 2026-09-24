import { parseArgs } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@fantasy/domain/spatial';
import { BattleBundles } from './battle-bundle.ts';
import { readBoundedFile } from './replay-files.ts';
import { exportPublication } from './publication-export.ts';
import { publicationDirectory } from './publication-files.ts';
import { publishPublication, prunePublication, PublicationFailure } from './publication-remote.ts';
import { restorePublication } from './publication-restore.ts';
import { PublicationS3 } from './publication-s3.ts';
import { ancestorOf, publicHttp } from './publication-http.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = async (path: string, limit: number) =>
  JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedFile(resolve(path), limit)),
  ) as unknown;
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      'require-complete-input': { type: 'boolean' },
      confirm: { type: 'boolean' },
    },
  });
  const [command, input, output, ...files] = positionals;
  if (
    !input ||
    (values['require-complete-input'] && command !== 'publish') ||
    !(
      (command === 'publish' &&
        output &&
        files.length >= 2 &&
        files.length % 2 === 0 &&
        files.length <= 128 &&
        !values.confirm) ||
      (command === 'prune' && !output && !values['dry-run']) ||
      (command === 'restore' && !output && !values['dry-run'] && !values.confirm)
    )
  )
    throw new Error(
      'Usage: publication publish plan.json public-dir index.json bundle-root [index.json bundle-root ...] [--dry-run] [--require-complete-input] | restore new-public-dir | prune public-dir [--confirm]',
    );
  const root = resolve(command === 'publish' ? output! : input),
    lock = root + '.remote-lock';
  await publicationDirectory(resolve(root, '..'), true);
  await mkdir(lock); // One administrator/process, including restore and explicit orphan cleanup.
  let store: PublicationS3 | undefined;
  try {
    if (command === 'publish') {
      const indexes = [];
      for (let i = 0; i < files.length; i += 2)
        indexes.push({
          index: await readJson(files[i]!, 2_000_000),
          bundles: new BattleBundles(resolve(files[i + 1]!)),
        });
      const exported = await exportPublication(await readJson(input, 8_000_000), indexes, root);
      console.log(canonicalJson({ phase: 'export', complete: exported.complete }));
      if (values['require-complete-input'] && !exported.complete)
        throw new Error('The current publication input must be complete');
    }
    store = new PublicationS3({
      accountId: required('R2_ACCOUNT_ID'),
      bucket: required('R2_BUCKET'),
      accessKeyId: required('R2_ACCESS_KEY_ID'),
      secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    });
    if (command === 'restore')
      console.log(
        canonicalJson(
          await restorePublication(
            root,
            store,
            Number(process.env.PUBLICATION_MAX_RESTORE_BYTES ?? 256_000_000),
          ),
        ),
      );
    else if (command === 'prune')
      console.log(canonicalJson(await prunePublication(store, values.confirm ?? false)));
    else {
      const viewer = publicHttp(required('PUBLICATION_VIEWER_URL')),
        worker = publicHttp(required('PUBLICATION_WORKER_URL'));
      const result = await publishPublication(root, store, {
        viewer: async () =>
          JSON.parse((await viewer('build.json', 4096)).toString('utf8')) as unknown,
        worker,
        ancestor: (source, viewer) => ancestorOf(source, viewer, repository),
        dryRun: values['dry-run'] ?? false,
        maxBytes: Number(process.env.PUBLICATION_MAX_BYTES ?? 8_000_000_000),
        maxWrites: Number(process.env.PUBLICATION_MAX_WRITES ?? 10000),
        maxTransferBytes: Number(process.env.PUBLICATION_MAX_TRANSFER_BYTES ?? 256_000_000),
        maxWorkerRequests: Number(process.env.PUBLICATION_MAX_WORKER_REQUESTS ?? 200),
        observe: (report) => console.log(canonicalJson({ phase: 'preflight', ...report })),
      });
      console.log(canonicalJson(result));
      // Complete-input mode preserves historical counts without misclassifying verified uploads.
      if (result.incompleteRows && !values['require-complete-input']) process.exitCode = 2;
    }
  } finally {
    if (store) console.log(canonicalJson({ phase: 's3-transport', ...store.metrics() }));
    store?.close();
    await rm(lock, { recursive: true });
  }
}
await main().catch((error: unknown) => {
  console.error(
    canonicalJson({
      status: error instanceof PublicationFailure ? error.phase : 'failed',
      message:
        error instanceof PublicationFailure
          ? error.message
          : 'Publication failed; review inputs, runtime configuration and network access.',
    }),
  );
  process.exitCode = 1;
});
