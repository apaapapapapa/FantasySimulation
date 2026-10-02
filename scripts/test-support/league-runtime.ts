import { mkdir, writeFile, symlink, cp } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildLeagueRuntime } from '../league-runtime.ts';

export async function runtimeFixture(root: string, artifactVersion = '6.2.1') {
  const source = join(root, 'source'),
    distribution = join(root, 'distribution'),
    target = join(root, 'target');
  const write = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await write(join(source, '.node-version'), process.version.slice(1));
  await write(join(source, 'pnpm-lock.yaml'), 'fixture lock');
  const workspaces = {
    api: 'apps/api',
    cli: 'apps/cli',
    domain: 'packages/domain',
    engine: 'packages/engine',
    samples: 'packages/samples',
  };
  for (const [name, path] of Object.entries(workspaces)) {
    await write(
      join(source, path, 'package.json'),
      JSON.stringify({ name: '@fantasy/' + name, type: 'module' }),
    );
    const link = join(source, 'node_modules/@fantasy', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), join(source, path)), link);
  }
  for (const name of [
    '@actions/artifact',
    '@protobuf-ts/runtime-rpc',
    '@octokit/core',
    '@octokit/plugin-paginate-rest',
    '@playwright/test',
    'tsx',
    'zod',
  ]) {
    const real = join(
      source,
      'node_modules/.pnpm',
      name.replace('/', '+') + '@1/node_modules',
      name,
    );
    await write(
      join(real, 'package.json'),
      JSON.stringify({
        name,
        version: name === '@actions/artifact' ? artifactVersion : '1.0.0',
        type: 'module',
        exports: './index.js',
        ...(name === '@actions/artifact'
          ? { dependencies: { '@protobuf-ts/plugin': '2.11.1' } }
          : {}),
      }),
    );
    await write(join(real, 'index.js'), 'export const fixture = true;');
    await write(join(real, 'native.node'), 'opaque native bytes');
    const link = join(source, 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), real), link);
  }
  await write(
    join(source, 'node_modules/@actions/artifact/index.js'),
    'export {fixture} from "@protobuf-ts/runtime-rpc";',
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'runtime-fixture@example.invalid');
  git('config', 'user.name', 'Runtime fixture');
  await write(join(source, '.gitignore'), 'node_modules\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  execFileSync('git', ['clone', '--quiet', source, target]);
  await buildLeagueRuntime(source, distribution, sha);
  return {
    source,
    distribution,
    target,
    sha,
    async copyTarget(destination: string) {
      await cp(target, destination, { recursive: true });
    },
  };
}
