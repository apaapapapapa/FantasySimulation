import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { contentHash } from '../packages/domain/src/spatial/index.ts';
import { sampleCatalog } from '@fantasy/samples';
import { assertPublishedRevisions } from './catalog-history.ts';
const directory = new URL('../data/spatial/', import.meta.url);
const file = new URL('catalog.json', directory);
const catalog = await sampleCatalog();
await assertPublishedRevisions(catalog);
if (process.argv.includes('--write')) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
} else if (
  (await contentHash(JSON.parse(readFileSync(file, 'utf8')))) !== (await contentHash(catalog))
) {
  throw new Error(
    'Sample catalog differs; review and regenerate with node scripts/spatial-catalog.ts --write',
  );
}
console.log(
  `Validated ${catalog.filter((r) => r.kind === 'character').length} characters and ${catalog.length} immutable revisions`,
);
