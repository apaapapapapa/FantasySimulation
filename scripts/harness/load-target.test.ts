import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { createTestProject } from '../quality/test-support/project.ts';
import { targetEntry } from './load-capture.ts';

it('uses the target package public export even when its implementation moves', () => {
  const project = createTestProject({
    'packages/engine/package.json': JSON.stringify({
      name: '@fantasy/engine',
      exports: { './spatial': './public.ts' },
    }),
    'packages/engine/public.ts': 'export const engine = 1;',
  });
  try {
    expect(fileURLToPath(targetEntry(project.root, '@fantasy/engine/spatial'))).toBe(
      join(project.root, 'packages/engine/public.ts'),
    );
  } finally {
    project.dispose();
  }
});

it.each([{}, { './spatial': './missing.ts' }, { './spatial': '../foreign.ts' }])(
  'fails closed for an unavailable public target %j',
  (exports) => {
    const project = createTestProject({
      'packages/engine/package.json': JSON.stringify({ name: '@fantasy/engine', exports }),
    });
    try {
      expect(() => targetEntry(project.root, '@fantasy/engine/spatial')).toThrow();
    } finally {
      project.dispose();
    }
  },
);
