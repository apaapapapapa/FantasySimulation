import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip, gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const maxBytes = 512 * 1024 ** 2,
  maxArchive = 128 * 1024 ** 2;
const hash = (data: Uint8Array) => 'sha256:' + createHash('sha256').update(data).digest('hex');
type Entry =
  | { type: 'file'; path: string; bytes: number; hash: string; mode: 420 | 493 }
  | { type: 'link'; path: string; target: string };
type RuntimeManifestValue = {
  schemaVersion: 1;
  sourceSha: string;
  node: string;
  platform: 'linux';
  arch: 'x64' | 'arm64';
  lockHash: string;
  archiveHash: string;
  archiveBytes: number;
  files: Entry[];
};
const RuntimeManifest = {
  // Bootstrap runs before dependencies exist, so this closed format uses only Node builtins.
  parse(input: unknown): RuntimeManifestValue {
    const object = (value: unknown, keys: string[]) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
      )
        throw new Error('Invalid runtime manifest object');
      return value as Record<string, unknown>;
    };
    const value = object(input, [
      'schemaVersion',
      'sourceSha',
      'node',
      'platform',
      'arch',
      'lockHash',
      'archiveHash',
      'archiveBytes',
      'files',
    ]);
    const sha = (value: unknown) =>
      typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
    const integer = (value: unknown, min: number, max: number) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
    if (
      value.schemaVersion !== 1 ||
      typeof value.sourceSha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(value.sourceSha) ||
      typeof value.node !== 'string' ||
      !/^v24\.\d+\.\d+$/.test(value.node) ||
      value.platform !== 'linux' ||
      !['x64', 'arm64'].includes(String(value.arch)) ||
      !sha(value.lockHash) ||
      !sha(value.archiveHash) ||
      !integer(value.archiveBytes, 1, maxArchive) ||
      !Array.isArray(value.files) ||
      value.files.length < 1 ||
      value.files.length > 50000
    )
      throw new Error('Invalid runtime manifest identity');
    for (const file of value.files) {
      const entry = object(
        file,
        file?.type === 'file'
          ? ['type', 'path', 'bytes', 'hash', 'mode']
          : ['type', 'path', 'target'],
      );
      if (
        typeof entry.path !== 'string' ||
        (entry.type === 'file'
          ? !integer(entry.bytes, 0, maxBytes) ||
            !sha(entry.hash) ||
            ![420, 493].includes(Number(entry.mode))
          : entry.type !== 'link' || typeof entry.target !== 'string')
      )
        throw new Error('Invalid runtime manifest entry');
    }
    return value as RuntimeManifestValue;
  },
};
const rootDependencies = [
  '@fantasy/api',
  '@fantasy/cli',
  '@fantasy/domain',
  '@fantasy/engine',
  '@fantasy/samples',
  '@actions/artifact',
  // Artifact 6.2.1 generated RPC code imports this undeclared runtime dependency.
  '@protobuf-ts/runtime-rpc',
  '@octokit/core',
  '@octokit/plugin-paginate-rest',
  'tsx',
];
const workspaces = [
  'apps/api',
  'apps/cli',
  'packages/domain',
  'packages/engine',
  'packages/samples',
];

function inside(root: string, path: string) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || rel.split(sep).some((p) => !p))
    throw new Error('Runtime path escapes checkout');
  return rel.split(sep).join('/');
}
function dependencyPath(path: string) {
  if (
    path.includes('\\') ||
    path.split('/').some((p) => !p || p === '.' || p === '..') ||
    !['node_modules/', ...workspaces.map((p) => p + '/node_modules/')].some((prefix) =>
      path.startsWith(prefix),
    )
  )
    throw new Error('Invalid runtime dependency path');
}
async function bounded(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.size > BigInt(limit))
      throw new Error('Runtime file size/type bound');
    const size = Number(info.size),
      data = Buffer.alloc(size + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      length !== size ||
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs
    )
      throw new Error('Runtime file changed while reading');
    return data.subarray(0, size);
  } finally {
    await file.close();
  }
}
async function runtimeIdentity(root: string, sourceSha: string) {
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    process.platform !== 'linux' ||
    process.version.slice(1) !== (await readFile(join(root, '.node-version'), 'utf8')).trim() ||
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== sourceSha
  )
    throw new Error('Runtime source/Node/platform mismatch');
  return {
    sourceSha,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    lockHash: hash(await bounded(join(root, 'pnpm-lock.yaml'), 4000000)),
  };
}

/** Dependencies only: source comes from the exact checkout, never from a cached artifact. */
export async function buildLeagueRuntime(checkout: string, destination: string, sourceSha: string) {
  const root = resolve(checkout),
    output = resolve(destination);
  const identity = await runtimeIdentity(root, sourceSha);
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
    throw new Error('Runtime build requires a clean committed source');
  const files = new Map<string, Entry>();
  const packages = new Set<string>();
  let bytes = 0;
  async function add(path: string) {
    const name = inside(root, path);
    dependencyPath(name);
    if (files.has(name)) return;
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await readlink(path),
        resolved = resolve(dirname(path), target);
      const relativeTarget = inside(root, resolved);
      if (
        target.startsWith('/') ||
        (!workspaces.includes(relativeTarget) &&
          !relativeTarget.includes('/node_modules/') &&
          !relativeTarget.startsWith('node_modules/'))
      )
        throw new Error('Runtime link outside dependency closure');
      files.set(name, { type: 'link', path: name, target });
    } else if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await add(join(path, entry));
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > maxBytes || files.size >= 50000) throw new Error('Runtime distribution budget');
      files.set(name, {
        type: 'file',
        path: name,
        bytes: info.size,
        hash: hash(await bounded(path, maxBytes)),
        mode: info.mode & 0o111 ? 0o755 : 0o644,
      });
    } else throw new Error('Runtime contains special file');
  }
  async function dependency(from: string, name: string, optional: boolean) {
    let directory = from;
    while (true) {
      const path = join(directory, 'node_modules', name);
      try {
        await lstat(path);
        await add(path);
        const resolved = await realpath(path);
        inside(root, resolved);
        await pkg(resolved);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (directory === root) break;
      directory = dirname(directory);
      if (!directory.startsWith(root)) break;
    }
    if (!optional) throw new Error('Missing runtime dependency: ' + name);
  }
  async function pkg(directory: string) {
    if (packages.has(directory)) return;
    packages.add(directory);
    const workspace = workspaces.includes(inside(root, directory));
    if (!workspace) await add(directory);
    const value = JSON.parse(
      (await bounded(join(directory, 'package.json'), 1000000)).toString('utf8'),
    );
    const optional = value.optionalDependencies ?? {};
    const dependencies = {
      ...value.dependencies,
      ...value.peerDependencies,
      ...optional,
      ...(workspace && value.devDependencies?.tsx ? { tsx: value.devDependencies.tsx } : {}),
    };
    for (const name of Object.keys(dependencies).sort())
      await dependency(
        directory,
        name,
        name in optional || value.peerDependenciesMeta?.[name]?.optional === true,
      );
  }
  for (const name of rootDependencies) await dependency(root, name, false);
  const inventory = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  await mkdir(output, { recursive: true });
  const archive = join(output, 'runtime.gz');
  async function* payload() {
    for (const file of inventory)
      if (file.type === 'file') {
        const data = await bounded(join(root, file.path), file.bytes);
        if (data.length !== file.bytes || hash(data) !== file.hash)
          throw new Error('Runtime build input changed');
        yield data;
      }
  }
  await pipeline(
    Readable.from(payload()),
    createGzip(),
    createWriteStream(archive, { flags: 'wx' }),
  );
  const compressed = await bounded(archive, maxArchive);
  const manifest = RuntimeManifest.parse({
    schemaVersion: 1,
    ...identity,
    archiveHash: hash(compressed),
    archiveBytes: compressed.length,
    files: inventory,
  });
  if (compressed.length + Buffer.byteLength(JSON.stringify(manifest)) > 63 * 1024 ** 2)
    throw new Error('Runtime immutable ZIP capacity exceeded');
  await writeFile(join(output, 'runtime.json'), JSON.stringify(manifest) + '\n', { flag: 'wx' });
  return {
    files: inventory.length,
    bytes,
    archiveBytes: compressed.length,
    archiveHash: manifest.archiveHash,
  };
}

/** Caller must authenticate the enclosing immutable ZIP against successful same-SHA main CI. */
export async function installLeagueRuntime(
  checkout: string,
  distribution: string,
  sourceSha: string,
) {
  const root = resolve(checkout);
  const expected = await runtimeIdentity(root, sourceSha);
  const manifest = RuntimeManifest.parse(
    JSON.parse((await bounded(join(distribution, 'runtime.json'), 16000000)).toString('utf8')),
  );
  if (
    Object.entries(expected).some(
      ([key, value]) => manifest[key as keyof typeof expected] !== value,
    )
  )
    throw new Error('Runtime identity mismatch');
  const paths = new Set<string>();
  let size = 0;
  for (const entry of manifest.files) {
    dependencyPath(entry.path);
    if (paths.has(entry.path)) throw new Error('Duplicate runtime path');
    paths.add(entry.path);
    if (entry.type === 'file') size += entry.bytes;
    else {
      const destination = inside(root, resolve(root, dirname(entry.path), entry.target));
      if (
        entry.target.startsWith('/') ||
        (!workspaces.includes(destination) &&
          !destination.includes('/node_modules/') &&
          !destination.startsWith('node_modules/'))
      )
        throw new Error('Invalid runtime link target');
    }
  }
  if (size > maxBytes) throw new Error('Runtime extraction budget');
  for (const entry of manifest.files)
    for (let parent = dirname(entry.path); parent !== '.'; parent = dirname(parent))
      if (paths.has(parent)) throw new Error('Runtime file/link used as directory');
  const archive = await bounded(join(distribution, 'runtime.gz'), maxArchive);
  if (archive.length !== manifest.archiveBytes || hash(archive) !== manifest.archiveHash)
    throw new Error('Runtime archive hash mismatch');
  const data = gunzipSync(archive, { maxOutputLength: maxBytes });
  if (data.length !== size) throw new Error('Runtime extracted length mismatch');
  let offset = 0;
  for (const entry of manifest.files)
    if (entry.type === 'file') {
      const chunk = data.subarray(offset, offset + entry.bytes);
      offset += entry.bytes;
      if (hash(chunk) !== entry.hash) throw new Error('Runtime native/file digest mismatch');
    }
  // Reject an existing dependency installation or symlinked checkout before any write.
  for (const directory of ['node_modules', ...workspaces.map((p) => p + '/node_modules')]) {
    try {
      await lstat(join(root, directory));
      throw new Error('Runtime install requires empty dependencies');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (let parent = dirname(directory); parent !== '.'; parent = dirname(parent))
      if ((await lstat(join(root, parent))).isSymbolicLink())
        throw new Error('Symlinked runtime checkout');
  }
  offset = 0;
  for (const entry of manifest.files)
    if (entry.type === 'file') {
      const path = join(root, entry.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data.subarray(offset, offset + entry.bytes), {
        flag: 'wx',
        mode: entry.mode,
      });
      offset += entry.bytes;
    }
  for (const entry of manifest.files)
    if (entry.type === 'link') {
      const path = join(root, entry.path);
      await mkdir(dirname(path), { recursive: true });
      await symlink(entry.target, path);
    }
  return { sourceSha, files: manifest.files.length, bytes: size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, output, sha] = process.argv.slice(2);
  if (!output || !sha) throw new Error('Expected build|install directory source-SHA');
  console.log(
    JSON.stringify(
      await (
        operation === 'build'
          ? buildLeagueRuntime
          : operation === 'install'
            ? installLeagueRuntime
            : () => {
                throw new Error('Unknown runtime operation');
              }
      )(process.cwd(), output, sha),
    ),
  );
}
