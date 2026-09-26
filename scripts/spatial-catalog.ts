import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash, parseJson, RevisionSchema } from '@fantasy/domain/spatial';
import { compileCatalog, catalogChanges } from '@fantasy/samples/authoring';
import { assertPublishedRevisions } from './catalog-history.ts';
import { readContentSources } from './content-sources.ts';

if (process.argv.slice(2).some((argument) => argument !== '--write'))
  throw new Error('Usage: node scripts/spatial-catalog.ts [--write]');
const directory = new URL('../data/spatial/', import.meta.url);
const file = new URL('catalog.json', directory);
const sources = readContentSources(fileURLToPath(new URL('../data/content/', import.meta.url)));
const catalog = await compileCatalog(sources.inputs);
await assertPublishedRevisions(catalog);
const previous = parseJson(RevisionSchema.array(), JSON.parse(readFileSync(file, 'utf8')));
console.log(JSON.stringify(catalogChanges(previous, catalog), null, 2));
if (process.argv.includes('--write')) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
} else if ((await contentHash(previous)) !== (await contentHash(catalog))) {
  throw new Error(
    'Authored catalog differs; review and regenerate with node scripts/spatial-catalog.ts --write',
  );
}
console.log(
  `Validated ${catalog.filter((r) => r.kind === 'character').length} characters and ${catalog.length} immutable revisions from ${sources.files.length} source files`,
);
