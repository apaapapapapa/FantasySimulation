import { execFileSync, spawn } from 'node:child_process';

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  reason: string;
  output: string;
}
export function validationEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { CI: 'true', NO_COLOR: '1' };
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMP|TEMP|TMPDIR|PNPM_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|VP_HOME|VITE_PLUS_HOME)$/i;
  for (const [name, value] of Object.entries(input)) {
    if (allowed.test(name) && value !== undefined) output[name] = value;
  }
  return output;
}
export function redact(output: string, environment: NodeJS.ProcessEnv): string {
  let result = output;
  for (const [name, value] of Object.entries(environment)) {
    if (/token|secret|password|api.?key/i.test(name) && value && value.length >= 4) {
      result = result.split(value).join('[REDACTED]');
    }
  }
  return result.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]');
}
/** Program/arguments are chosen in source code, never loaded from reports or task prose. */
export function runCommand(
  file: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxBytes = 2 * 1024 * 1024,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], {
      cwd,
      env: validationEnvironment(process.env),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let reason = 'completed';
    let settled = false;
    function killTree() {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 5000,
            windowsHide: true,
          });
        } else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    function finish(exitCode: number | null, signal: string | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, reason, output: redact(Buffer.concat(chunks).toString('utf8'), process.env) });
    }
    const timer = setTimeout(() => {
      reason = 'deadline exceeded';
      killTree();
    }, timeoutMs);
    const capture = (chunk: Buffer) => {
      const remaining = maxBytes - bytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reason = 'output limit exceeded';
        killTree();
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', () => {
      reason = 'process could not start';
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
