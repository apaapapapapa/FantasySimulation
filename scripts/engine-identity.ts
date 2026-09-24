import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { engineIdentity, verifyIdentity } from './identity/identity.ts';
import { OUTPUT } from './identity/closure.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.slice(2).some((argument) => !['--write', '--inputs'].includes(argument)))
  throw Error('Usage: node scripts/engine-identity.ts [--write] [--inputs]');
const { implementation, payload } = engineIdentity(root);
if (process.argv.includes('--write'))
  writeFileSync(join(root, OUTPUT), `${JSON.stringify(implementation, null, 2)}\n`);
else verifyIdentity(root, implementation);
if (process.argv.includes('--inputs')) console.log(JSON.stringify(payload, null, 2));
console.log(
  `Engine identity ${process.argv.includes('--write') ? 'stamped' : 'verified'} (${payload.algorithm}, ${payload.sources.length} sources): ${implementation.digest}`,
);
