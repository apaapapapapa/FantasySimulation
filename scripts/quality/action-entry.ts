import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import { importEdges, withSources } from './ast.ts';

const source = 'scripts/league-artifact-action.ts';
const entry = '.github/actions/league-artifact-command/dist/main.mjs';
const generatedEntry =
  '// Generated Node24 entry; checked by quality:typescript.\n' +
  "import '../../../../scripts/league-artifact-action.ts';\n";

/** Only this fixed Node24 bootstrap is a generated action entry, never arbitrary JavaScript. */
export function actionEntryFindings(root: string) {
  const findings: { path: string; correction: string }[] = [];
  if (readFileSync(join(root, entry), 'utf8').replaceAll('\r\n', '\n') !== generatedEntry)
    findings.push({ path: entry, correction: 'Restore the fixed generated Node24 bootstrap.' });
  return withSources(root, [source], (files) => {
    for (const edge of importEdges(files.get(source)!))
      if (!edge.specifier.startsWith('node:') || !isBuiltin(edge.specifier))
        findings.push({
          path: source,
          correction: 'The action entry must import only Node builtins: ' + edge.specifier,
        });
    return findings;
  });
}
