import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  PublicKeySchema,
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  PublicReplaySetSchema,
  PublicMatchPageSchema,
  BundleReceiptSchema,
  ReplayManifestSchema,
} from '@fantasy/domain/spatial';

/** Fixed exported bytes, independent of the API/SQLite/engine and browser adapter. */
export function publicFixtures(root: string) {
  const directory = join(root, 'apps/web/test-fixtures/publication');
  const archive = readFileSync(join(directory, 'files.json.gz'));
  const provenance: unknown = JSON.parse(readFileSync(join(directory, 'provenance.json'), 'utf8'));
  if (
    !provenance ||
    typeof provenance !== 'object' ||
    !('archiveHash' in provenance) ||
    provenance.archiveHash !== `sha256:${createHash('sha256').update(archive).digest('hex')}`
  )
    throw new Error('Public fixture archive checksum mismatch');
  const entries: unknown = JSON.parse(
    gunzipSync(archive, { maxOutputLength: 16 * 1024 ** 2 }).toString('utf8'),
  );
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    throw new Error('Invalid public fixture archive');
  const files = new Map<string, Buffer>();
  for (const [key, value] of Object.entries(entries)) {
    PublicKeySchema.parse(key);
    if (
      typeof value !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    )
      throw new Error('Invalid public fixture bytes');
    const bytes = Buffer.from(value, 'base64');
    if (key.endsWith('.json')) {
      const json: unknown = JSON.parse(bytes.toString('utf8'));
      if (key === 'catalog/current.json') PublicCatalogCurrentSchema.parse(json);
      else if (key.startsWith('catalog/')) PublicCatalogSchema.parse(json);
      else if (key.endsWith('/set.json')) PublicReplaySetSchema.parse(json);
      else if (key.startsWith('sets/')) PublicMatchPageSchema.parse(json);
      else if (key.endsWith('/receipt.json')) BundleReceiptSchema.parse(json);
      else ReplayManifestSchema.parse(json);
    }
    files.set(key, bytes);
  }
  return files;
}
