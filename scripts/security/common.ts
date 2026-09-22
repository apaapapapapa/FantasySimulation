import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Status = 'pass' | 'fail' | 'unknown';
export type Outcome = {
  status: Status;
  reason: string;
  counts: Record<string, number>;
};

// Only fixed error codes, never subprocess output, may leave the runner.
export class SecurityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new SecurityError(code);
}

export function object(value: unknown): Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'INVALID_OBJECT',
  );
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  requireCondition(Array.isArray(value), 'INVALID_ARRAY');
  return value;
}

export function text(value: unknown): string {
  requireCondition(typeof value === 'string' && value.length > 0, 'INVALID_TEXT');
  return value;
}

export function count(value: unknown): number {
  requireCondition(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'INVALID_COUNT',
  );
  return value;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function command(program: string, args: string[], cwd = process.cwd()) {
  // No shell, inherited credentials, raw logging, or unbounded buffers.
  const env: NodeJS.ProcessEnv = {};
  const keys = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LOCALAPPDATA',
    'APPDATA',
    'VITE_PLUS_HOME',
    'PNPM_HOME',
  ];
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
}

export function successful(program: string, args: string[], cwd = process.cwd()): string {
  const result = command(program, args, cwd);
  requireCondition(!result.error && result.status === 0 && !result.signal, 'COMMAND_FAILED');
  return result.stdout.trim();
}

export function isMain(url: string): boolean {
  return fileURLToPath(url) === resolve(process.argv[1] ?? '');
}

export function exitCode(status: Status): number {
  return status === 'pass' ? 0 : status === 'fail' ? 1 : 2;
}

export function writeReceipt(checkId: string, outcome: Outcome): void {
  const sourceSha = successful('git', ['rev-parse', 'HEAD']);
  requireCondition(/^[a-f0-9]{40}$/.test(sourceSha), 'INVALID_SOURCE_SHA');
  if (process.env.GITHUB_SHA) {
    requireCondition(sourceSha === process.env.GITHUB_SHA, 'CHECKOUT_SHA_MISMATCH');
  }
  const receipt = {
    schemaVersion: 1,
    producer: 'fantasy-security-h4',
    checkId,
    sourceSha,
    prHeadSha: process.env.H4_PR_HEAD_SHA || null,
    baselineSha: process.env.H4_BASE_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    completedAt: new Date().toISOString(),
    ...outcome,
  };
  const directory = process.env.H4_REPORT_DIR || join(tmpdir(), 'fantasy-security');
  const output = join(directory, `${checkId}.json`);
  const json = JSON.stringify(receipt, null, 2);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${json}\n`, { mode: 0o600 });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${checkId}\n\n\`\`\`json\n${json}\n\`\`\`\n`,
    );
  }
  console.log(`${checkId}: ${outcome.status} (${outcome.reason})`);
}

export function main(checkId: string, evaluate: () => Outcome): void {
  let result: Outcome;
  try {
    result = evaluate();
  } catch (error: unknown) {
    result = {
      status: 'unknown',
      reason: error instanceof SecurityError ? error.code : 'INVALID_OR_MISSING_EVIDENCE',
      counts: {},
    };
  }
  try {
    writeReceipt(checkId, result);
  } catch {
    console.error(`${checkId}: unknown (RECEIPT_FAILED)`);
    process.exitCode = 2;
    return;
  }
  process.exitCode = exitCode(result.status);
}
