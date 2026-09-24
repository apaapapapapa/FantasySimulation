import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { record, text } from '../harness/report.ts';
import { contained, json, sourceText } from './files.ts';

const yaml = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => unknown };
export interface RuntimeImport {
  importer: string;
  name: string;
}
export function packageName(specifier: string): string {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w./-]+)?$/.test(specifier))
    throw Error(`Unsupported runtime import: ${specifier}`);
  return specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');
}
export function owner(root: string, file: string): string {
  let directory = dirname(resolve(root, file));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw Error(`Package owner missing: ${file}`);
    directory = parent;
  }
  return directory;
}
function installed(from: string, name: string): string {
  let directory = from;
  while (true) {
    const candidate = join(directory, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    const parent = dirname(directory);
    if (parent === directory) throw Error(`Runtime dependency is not installed: ${name}`);
    directory = parent;
  }
}
export function lockData(root: string) {
  const lock = record(yaml.load(sourceText(root, 'pnpm-lock.yaml')));
  if (lock.lockfileVersion !== '9.0') throw Error('Unsupported identity lockfile format');
  return {
    importers: record(lock.importers),
    packages: record(lock.packages),
    snapshots: record(lock.snapshots),
  };
}
export type LockData = ReturnType<typeof lockData>;
export function importerDependency(root: string, lock: LockData, importer: string, name: string) {
  const pkg = json(join(root, importer, 'package.json'));
  const specifier = text(record(pkg.dependencies)[name]);
  const edge = record(record(record(lock.importers[importer]).dependencies)[name]);
  if (edge.specifier !== specifier) throw Error(`Unfrozen runtime dependency: ${importer}/${name}`);
  return text(edge.version);
}
export function workspaceTarget(
  root: string,
  lock: LockData,
  importer: string,
  specifier: string,
): string {
  const name = packageName(specifier),
    version = importerDependency(root, lock, importer, name);
  if (!version.startsWith('link:')) throw Error(`Expected workspace dependency: ${name}`);
  const directory = resolve(root, importer, version.slice(5));
  contained(root, directory);
  if (realpathSync(directory) !== installed(join(root, importer), name))
    throw Error(`Installed workspace mismatch: ${name}`);
  const pkg = json(join(directory, 'package.json'));
  if (pkg.type !== 'module' || pkg.name !== name)
    throw Error(`Unsupported workspace package: ${name}`);
  const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
  const target = text(record(pkg.exports)[subpath]);
  if (!target.startsWith('./') || target.includes('..', 2) || !target.endsWith('.ts'))
    throw Error(`Unsupported workspace export: ${specifier}`);
  return contained(root, resolve(directory, target));
}
/** Traverse selected pnpm snapshot edges, including peer-qualified and transitive identities. */
export function runtimeDependencies(root: string, lock: LockData, imports: RuntimeImport[]) {
  const dependencies = new Map<
    string,
    { id: string; integrity: string; dependencies: [string, string][] }
  >();
  const checked = new Set<string>();
  const visit = (name: string, version: string, from: string): string => {
    const base = version.split('(')[0]!;
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(base) || /[^\w.@()+/-]/.test(version))
      throw Error(`Unsupported runtime resolution: ${name}@${version}`);
    const id = `${name}@${version}`,
      directory = installed(from, name);
    const pkg = json(join(directory, 'package.json'));
    if (pkg.name !== name || pkg.version !== base)
      throw Error(`Installed runtime version mismatch: ${id}`);
    const location = `${id}:${directory}`;
    if (checked.has(location)) return id;
    checked.add(location);
    const metadata = record(lock.packages[`${name}@${base}`]);
    const resolution = record(metadata.resolution),
      integrity = text(resolution.integrity);
    if (
      !/^sha512-[A-Za-z\d+/]{86}==$/.test(integrity) ||
      Object.keys(resolution).some((key) => key !== 'integrity')
    )
      throw Error(`Unsupported or missing runtime integrity: ${id}`);
    const snapshot = record(lock.snapshots[id]);
    if (snapshot.patched) throw Error(`Patched runtime needs identity policy review: ${id}`);
    const children = {
      ...record(snapshot.dependencies ?? {}),
      ...record(snapshot.optionalDependencies ?? {}),
    };
    for (const child of Object.keys({
      ...record(pkg.dependencies ?? {}),
      ...record(pkg.optionalDependencies ?? {}),
    }))
      if (!(child in children)) throw Error(`Missing runtime dependency edge: ${id}/${child}`);
    for (const peer of Object.keys(record(metadata.peerDependencies ?? {}))) {
      const optional =
        record(record(metadata.peerDependenciesMeta ?? {})[peer] ?? {}).optional === true;
      if (!(peer in children) && !optional)
        throw Error(`Missing resolved runtime peer: ${id}/${peer}`);
    }
    const edges = Object.entries(children)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([child, value]): [string, string] => [child, visit(child, text(value), directory)]);
    dependencies.set(id, { id, integrity, dependencies: edges });
    return id;
  };
  const roots = [
    ...new Map(imports.map((edge) => [`${edge.importer}:${edge.name}`, edge])).values(),
  ]
    .sort((a, b) => (`${a.importer}:${a.name}` < `${b.importer}:${b.name}` ? -1 : 1))
    .map(({ importer, name }) => [
      importer,
      name,
      visit(name, importerDependency(root, lock, importer, name), join(root, importer)),
    ]);
  return {
    roots,
    packages: [...dependencies.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}
export function runtimePackage(root: string, importer: string, name: string): string {
  return installed(join(root, importer), name);
}
