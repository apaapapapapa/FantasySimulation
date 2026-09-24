import { redact } from './process.ts';

/** Diagnostics are separate from evidence: an exception never manufactures a report. */
export function harnessFailure(
  args: readonly string[],
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const bounded = (text: string) => redact(text, env).slice(0, 2048);
  return JSON.stringify({
    message:
      'Harness input or collection failed; evidence is incomplete. See .github/harness/README.md.',
    command: bounded(['node', 'scripts/harness.ts', ...args].join(' ')),
    error: {
      type: bounded(error instanceof Error ? error.name : 'NonError'),
      message: bounded(
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Non-Error thrown value',
      ),
      ...(error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' && { code: bounded(error.code) }),
    },
  });
}
