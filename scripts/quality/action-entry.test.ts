import { expect, it } from 'vite-plus/test';
import { actionEntryFindings } from './action-entry.ts';
import { createTestProject } from './test-support/project.ts';

it.each([
  ["import 'node:fs';", false, []],
  ["import 'tsx';", false, ['scripts/league-artifact-action.ts']],
  ["import './other.ts';", false, ['scripts/league-artifact-action.ts']],
  ["import 'node:fs';", true, ['.github/actions/league-artifact-command/dist/main.mjs']],
] as const)(
  'checks the fixed bootstrap and builtin-only source (%s, changed=%s)',
  (source, changed, paths) => {
    const project = createTestProject({
      'scripts/league-artifact-action.ts': source,
      'scripts/other.ts': 'export {};',
      '.github/actions/league-artifact-command/dist/main.mjs':
        '// Generated Node24 entry; checked by quality:typescript.\n' +
        "import '../../../../scripts/league-artifact-action.ts';\n" +
        (changed ? 'console.log(1);\n' : ''),
    });
    try {
      expect(actionEntryFindings(project.root).map((finding) => finding.path)).toEqual(paths);
    } finally {
      project.dispose();
    }
  },
);
