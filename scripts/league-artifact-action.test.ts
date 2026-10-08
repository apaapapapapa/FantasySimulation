import { expect, it } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const action = resolve('.github/actions/league-artifact-command/dist/main.mjs');
it('passes credentials only to the fixed child and preserves its exit status', async () => {
  await withReplayDirectory(async (root) => {
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, '.node-version'), process.version.slice(1));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await symlink(resolve('node_modules'), join(root, 'node_modules'), 'junction');
    const environmentFile = join(root, 'github-env');
    await writeFile(environmentFile, 'original\n');
    await writeFile(
      join(root, 'scripts/league-artifact-pilot.ts'),
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync('observed.json', JSON.stringify({
        token: process.env.ACTIONS_RUNTIME_TOKEN,
        results: process.env.ACTIONS_RESULTS_URL,
        args: process.argv.slice(2),
      }));
      process.exit(Number(process.env.FIXTURE_EXIT));
    `,
    );
    await writeFile(
      join(root, 'scripts/league-pipeline.ts'),
      await readFile(join(root, 'scripts/league-artifact-pilot.ts'), 'utf8'),
    );
    await writeFile(
      join(root, 'scripts/league-partition-pilot.ts'),
      await readFile(join(root, 'scripts/league-artifact-pilot.ts'), 'utf8'),
    );
    await writeFile(
      join(root, 'scripts/league-runner-calibration.ts'),
      await readFile(join(root, 'scripts/league-artifact-pilot.ts'), 'utf8'),
    );
    await writeFile(
      join(root, 'scripts/league-segment-service.ts'),
      await readFile(join(root, 'scripts/league-artifact-pilot.ts'), 'utf8'),
    );
    const env = {
      ...process.env,
      GITHUB_WORKSPACE: root,
      GITHUB_ENV: environmentFile,
      INPUT_COMMAND: 'pilot-produce',
      ACTIONS_RUNTIME_TOKEN: 'surrogate',
      ACTIONS_RESULTS_URL: 'https://results.invalid/',
    };
    for (const [command, argument, exit] of [
      ['pilot-produce', 'produce', 0],
      ['pilot-produce', 'produce', 7],
      ['transfer', 'transfer', 0],
      ['recover', 'recover', 7],
      ['partition-prepare', 'prepare', 0],
      ['partition-compute', 'compute', 7],
      ['partition-consume', 'consume', 0],
      ['calibration-prepare', 'prepare', 0],
      ['calibration-compute', 'compute', 7],
      ['calibration-consume', 'consume', 0],
      ['segment-service', undefined, 0],
    ] as const) {
      const result = spawnSync(process.execPath, [action], {
        env: { ...env, INPUT_COMMAND: command, FIXTURE_EXIT: String(exit) },
        encoding: 'utf8',
      });
      expect(result.status).toBe(exit);
      expect(JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'))).toEqual({
        token: 'surrogate',
        results: 'https://results.invalid/',
        args: argument === undefined ? [] : [argument],
      });
      expect(await readFile(environmentFile, 'utf8')).toBe('original\n');
    }
    const signals: { code: number; signal: string }[] = [];
    // Windows terminates processes directly; Linux CI exercises POSIX forwarding.
    if (process.platform !== 'win32') {
      await writeFile(
        join(root, 'scripts/league-artifact-pilot.ts'),
        `
        import { writeFileSync } from 'node:fs';
        process.on('SIGTERM', () => { writeFileSync('signal.json', 'SIGTERM'); process.exit(0); });
        process.on('SIGINT', () => { writeFileSync('signal.json', 'SIGINT'); process.exit(0); });
        setInterval(() => {}, 1000);
        console.log('ready');
      `,
      );
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        const child = spawn(process.execPath, [action], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        try {
          await once(child.stdout!, 'data');
          const closed = once(child, 'close');
          child.kill(signal);
          signals.push({
            code: (await closed)[0],
            signal: await readFile(join(root, 'signal.json'), 'utf8'),
          });
        } finally {
          child.kill('SIGKILL');
        }
      }
    }
    expect(signals).toEqual(
      process.platform === 'win32'
        ? []
        : [
            { code: 143, signal: 'SIGTERM' },
            { code: 130, signal: 'SIGINT' },
          ],
    );
    if (process.platform !== 'win32') {
      await writeFile(
        join(root, 'scripts/grandchild.mjs'),
        `
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
        console.log('grandchild-ready');
      `,
      );
      await writeFile(
        join(root, 'scripts/league-segment-service.ts'),
        `
        import { spawn } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        const child = spawn(process.execPath, ['scripts/grandchild.mjs'], { stdio: 'inherit' });
        writeFileSync('grandchild-pid.json', JSON.stringify(child.pid));
        let timer;
        process.on('SIGTERM', () => {
          child.kill('SIGTERM');
          timer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          writeFileSync('grandchild-drained.json', JSON.stringify({ code, signal }));
          setTimeout(() => process.exit(0), 500);
        });
      `,
      );
      const service = spawn(process.execPath, [action], {
        env: { ...env, INPUT_COMMAND: 'segment-service' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = once(service, 'close');
      let grandchildPid: number | undefined;
      try {
        await once(service.stdout!, 'data');
        grandchildPid = JSON.parse(await readFile(join(root, 'grandchild-pid.json'), 'utf8'));
        service.kill('SIGTERM');
        expect((await closed)[0]).toBe(143);
        expect(JSON.parse(await readFile(join(root, 'grandchild-drained.json'), 'utf8'))).toEqual({
          code: null,
          signal: 'SIGKILL',
        });
        expect(() => process.kill(grandchildPid!, 0)).toThrow();
      } finally {
        if (grandchildPid !== undefined) {
          try {
            process.kill(grandchildPid, 'SIGKILL');
          } catch {
            /* Already drained. */
          }
        }
        service.kill('SIGKILL');
        await closed;
      }
    }
    for (const command of ['constructor', 'prepare; echo injection', '../scripts/evil.ts']) {
      const result = spawnSync(process.execPath, [action], {
        env: { ...env, INPUT_COMMAND: command },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unsupported league command');
    }
    for (const credential of ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL']) {
      const result = spawnSync(process.execPath, [action], {
        env: { ...env, [credential]: '' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Missing action credential: ' + credential);
    }
  });
}, 20000);
