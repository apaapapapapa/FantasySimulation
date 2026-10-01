import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const commands: Record<string, string[]> = {
  'pilot-produce': ['scripts/league-artifact-pilot.ts', 'produce'],
  'pilot-consume': ['scripts/league-artifact-pilot.ts', 'consume'],
  'partition-prepare': ['scripts/league-partition-pilot.ts', 'prepare'],
  'partition-compute': ['scripts/league-partition-pilot.ts', 'compute'],
  'partition-consume': ['scripts/league-partition-pilot.ts', 'consume'],
  prepare: ['scripts/league-pipeline.ts', 'prepare'],
  admit: ['scripts/league-pipeline.ts', 'admit'],
  compute: ['scripts/league-pipeline.ts', 'compute'],
  transfer: ['scripts/league-pipeline.ts', 'transfer'],
  recover: ['scripts/league-pipeline.ts', 'recover'],
};
try {
  const command = process.env.INPUT_COMMAND;
  if (!Object.hasOwn(commands, command ?? '')) throw new Error('Unsupported league command');
  const cwd = process.env.GITHUB_WORKSPACE;
  if (!cwd) throw new Error('Missing GITHUB_WORKSPACE');
  for (const name of ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL'])
    if (!process.env[name]?.trim()) throw new Error('Missing action credential: ' + name);
  const version = readFileSync(join(cwd, '.node-version'), 'utf8').trim();
  const probe = spawnSync('node', ['--version'], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
  });
  if (probe.status !== 0 || probe.stdout.trim() !== 'v' + version)
    throw new Error('PATH node does not match .node-version');
  const child = spawn('node', ['--import', 'tsx', ...commands[command!]!], {
    cwd,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  let timer: NodeJS.Timeout | undefined;
  let interrupted: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals) => {
    interrupted = signal;
    child.kill(signal);
    timer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
  };
  const term = () => forward('SIGTERM');
  const interrupt = () => forward('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', interrupt);
  child.on('error', () => {
    console.error('Unable to start league command');
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    process.off('SIGTERM', term);
    process.off('SIGINT', interrupt);
    process.exitCode =
      interrupted === 'SIGINT' || signal === 'SIGINT'
        ? 130
        : interrupted || signal
          ? 143
          : (code ?? 1);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'League action failed');
  process.exitCode = 1;
}
