import { spawn, spawnSync } from 'node:child_process';

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  output: string;
  bounded: boolean;
}
export function safeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'APPDATA',
    'LOCALAPPDATA',
    'PATHEXT',
    'CI',
    'VP_HOME',
    'PNPM_HOME',
    'VITE_PLUS_HOME',
    'MIGRATION_BASE_SHA',
  ]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase())));
}
export function redact(output: string, env: NodeJS.ProcessEnv): string {
  let result = output;
  for (const [key, value] of Object.entries(env)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(key) && value && value.length >= 8)
      result = result.split(value).join('[REDACTED]');
  }
  return result.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]');
}
/** Bounded subprocess execution; a worktree is not a security sandbox. */
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 12 * 60 * 1000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  )
    throw new Error('Invalid process budget');
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: options.env ?? safeEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let bounded = false;
    const kill = () => {
      bounded = true;
      if (child.pid === undefined) return;
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 5000,
        });
      else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    const append = (chunk: Buffer) => {
      const remaining = maxBytes - bytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maxBytes) kill();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => append(Buffer.from(error.message)));
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        bounded,
        output: redact(Buffer.concat(chunks).toString('utf8'), process.env),
      });
    });
  });
}
