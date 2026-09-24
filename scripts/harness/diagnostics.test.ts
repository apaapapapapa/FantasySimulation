import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { harnessFailure } from './diagnostics.ts';
import { testRepository } from './test-support/repository.ts';

describe('harness failure diagnostics', () => {
  it.each([
    { args: ['context', 'unknown-topic'], type: 'Error', message: 'Unknown context topic' },
    { args: ['report', 'missing.json'], type: 'Error', message: 'ENOENT' },
    { args: ['report', 'malformed.json'], type: 'SyntaxError', message: 'JSON' },
    { args: [], type: 'Error', message: 'Harness input is required' },
  ])('keeps $args failures incomplete and explains the cause', ({ args, type, message }) => {
    const project = testRepository({ 'malformed.json': '{"broken":' });
    try {
      const result = spawnSync(process.execPath, [resolve('scripts/harness.ts'), ...args], {
        cwd: project.root,
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      const diagnostic = JSON.parse(result.stderr);
      expect(diagnostic.command).toBe(['node', 'scripts/harness.ts', ...args].join(' '));
      expect(diagnostic.message).toContain('evidence is incomplete');
      expect(diagnostic.error.type).toBe(type);
      expect(diagnostic.error.message).toContain(message);
      if (message === 'ENOENT') expect(diagnostic.error.code).toBe('ENOENT');
      expect(project.git('status', '--porcelain')).toBe('');
    } finally {
      project.dispose();
    }
  });

  it('redacts arguments and error details before bounding them; excludes stacks', () => {
    const secret = 'sensitive-value-for-test';
    const error = Object.assign(new TypeError(`Cannot read ${secret} ghp_exampletoken`), {
      code: secret,
      stack: 'Do not print a request or stack',
    });
    const text = harnessFailure(['report', secret], error, { GH_TOKEN: secret });
    const diagnostic = JSON.parse(text);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('ghp_exampletoken');
    expect(text).not.toContain(error.stack);
    expect(diagnostic.error).toEqual({
      type: 'TypeError',
      message: 'Cannot read [REDACTED] [REDACTED]',
      code: '[REDACTED]',
    });
    expect(diagnostic.command).toContain('[REDACTED]');
    const large = JSON.parse(harnessFailure(['x'.repeat(10_000)], new Error('y'.repeat(10_000))));
    expect(large.command).toHaveLength(2048);
    expect(large.error.message).toHaveLength(2048);
  });

  it.each(['thrown string', null, { request: 'must not serialize arbitrary objects' }])(
    'handles thrown non-Errors without exposing objects: %s',
    (error) => {
      expect(JSON.parse(harnessFailure(['source', 'evidence'], error)).error).toEqual({
        type: 'NonError',
        message: typeof error === 'string' ? error : 'Non-Error thrown value',
      });
    },
  );
});
