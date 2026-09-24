import { cruise } from 'dependency-cruiser';
import type { IRegularForbiddenRuleType, ICruiseResult } from 'dependency-cruiser';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  lstatSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { withSources, importEdges } from './ast.ts';
import { record, text } from '../harness/report.ts';
const rule = (
  name: string,
  from: IRegularForbiddenRuleType['from'],
  to: IRegularForbiddenRuleType['to'],
  comment: string,
): IRegularForbiddenRuleType => ({ name, from, to, comment, severity: 'error' });
export const boundaryRules: IRegularForbiddenRuleType[] = [
  rule(
    'engine-domain-execution-entry',
    { path: '^packages/engine/src/spatial/' },
    { path: '^packages/domain/', pathNot: '^packages/domain/src/spatial/execution[.]ts$' },
    'Engine runtime consumes only the domain execution entry.',
  ),
  rule(
    'execution-contract-boundary',
    {
      path: '^packages/domain/src/spatial/',
      pathNot: '/(?:index|api|batch|publication|replay|replay-state)[.]ts$',
    },
    {
      path: '^packages/domain/src/spatial/(?:index|api|batch|publication|replay|replay-state)[.]ts$',
    },
    'Execution contracts cannot pull transport, publication or replay validation into the digest.',
  ),
  rule(
    'samples-stay-outside-engine',
    { path: '^packages/engine/src/' },
    { path: '^packages/samples/' },
    'Sample builders depend on the public engine, never the reverse.',
  ),
  rule(
    'samples-use-public-engine',
    { path: '^packages/samples/src/' },
    {
      path: '^packages/engine/',
      pathNot: '^packages/engine/src/spatial/(?:index|execution)[.]ts$',
    },
    'Use the public engine API in sample builders.',
  ),
  rule(
    'unresolved',
    {},
    { couldNotResolve: true },
    'Resolve this dependency; do not hide missing imports.',
  ),
  rule(
    'no-browser-core',
    { path: '^(packages/domain|apps/web|apps/replay-reader)/' },
    { dependencyTypes: ['core'] },
    'Platform builtins do not belong in shared/browser contracts.',
  ),
  rule(
    'engine-core-boundary',
    { path: '^packages/engine/' },
    { dependencyTypes: ['core'], pathNot: '^(?:node:)?crypto$' },
    'Only the reviewed pure hashing boundary is allowed.',
  ),
  rule(
    'engine-hash-boundary',
    { path: '^packages/engine/', pathNot: '^packages/engine/src/hashing[.]ts$' },
    { path: '^(?:node:)?crypto$' },
    'Core crypto belongs only in the reviewed hashing adapter; named createHash is checked by the determinism guard.',
  ),
  rule(
    'no-app-harness',
    { path: '^(apps|packages)/' },
    { path: '^scripts/' },
    'Development harness cannot be an application dependency.',
  ),
  rule(
    'domain-is-independent',
    { path: '^packages/domain/' },
    {
      path: '^(apps/|scripts/|packages/engine/|node:|.*node_modules/(?:@dimforge|three|react|react-dom)/)',
    },
    'Move platform/physics code out of domain.',
  ),
  rule(
    'engine-is-headless',
    { path: '^packages/engine/' },
    { path: '^(apps/|scripts/|node:(?!crypto$)|.*node_modules/(?:react|react-dom|three)/)' },
    'Move I/O, UI and orchestration out of the engine.',
  ),
  rule(
    'web-is-client',
    { path: '^apps/web/' },
    { path: '^(apps/api/|packages/engine/|scripts/|node:)' },
    'Use shared domain contracts, not server or engine execution.',
  ),
  rule(
    'reader-is-read-only-transport',
    { path: '^apps/replay-reader/' },
    { path: '^(apps/(?:api|web)/|packages/engine/|scripts/|node:)' },
    'The edge reader may use only shared contracts and its read-only R2 binding.',
  ),
  rule(
    'reader-external-boundary',
    { path: '^apps/replay-reader/' },
    {
      path: '(?:^|/)node_modules/',
      pathNot: '(?:^|/)node_modules/(?:zod|@cloudflare/workers-types)/',
    },
    'Only shared validation and official Workers types belong in the reader runtime.',
  ),
  rule(
    'api-does-not-import-web',
    { path: '^apps/api/' },
    { path: '^apps/web/' },
    'Keep HTTP/persistence separate from UI.',
  ),
  rule(
    'domain-external-boundary',
    { path: '^packages/domain/' },
    { path: '(?:^|/)node_modules/', pathNot: '(?:^|/)node_modules/zod/' },
    'Only Zod is approved in shared contracts; keep I/O and library-specific public types outside domain.',
  ),
  rule(
    'engine-external-boundary',
    { path: '^packages/engine/' },
    { path: '(?:^|/)node_modules/', pathNot: '(?:^|/)node_modules/@dimforge/rapier3d-compat/' },
    'Only the physics adapter has an approved external runtime dependency.',
  ),
  rule(
    'browser-external-boundary',
    { path: '^apps/web/' },
    {
      path: '(?:^|/)node_modules/',
      pathNot:
        '(?:^|/)node_modules/(?:react|react-dom|zod|three|@react-three/(?:fiber|drei)|@tanstack/react-table)/',
    },
    'Review browser safety before adding another runtime dependency; server/SQLite/tooling belong outside web.',
  ),
  rule(
    'development-tools-stay-outside-runtime',
    { path: '^(apps|packages)/' },
    { path: '(?:^|/)node_modules/(?:@octokit|dependency-cruiser|typescript|vite-plus)/' },
    'Development SDKs and parsers belong in scripts, not application runtime.',
  ),
  rule(
    'rapier-physics-boundary',
    { path: '^(apps|packages)/', pathNot: '^packages/engine/src/spatial/physics[.]ts$' },
    { path: '(?:^|/)node_modules/@dimforge/' },
    'Import Rapier only from the physics boundary.',
  ),
];
export interface ArchitectureResult {
  publicGraph: ICruiseResult;
  runtimeGraph: ICruiseResult;
}
/** TS7 owns parsing; dependency-cruiser owns resolution, graph construction and all rules. */
export async function architecture(root: string, paths: string[]): Promise<ArchitectureResult> {
  const sources = paths.filter(
    (path) =>
      /^(apps|packages)\/[^/]+\/src\/.*\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path),
  );
  if (!sources.length) throw Error('Architecture source coverage is empty');
  const parsed = withSources(root, sources, (files, options) => ({
    edges: new Map(
      [...files].map(([path, file]) => [
        path,
        importEdges(file, path === 'apps/web/src/vite-env.d.ts' ? 'vite-plus/client' : undefined),
      ]),
    ),
    options,
  }));
  const { edges, options } = parsed;
  for (const path of ['.generated', '.generated/architecture'])
    if (existsSync(join(root, path)) && lstatSync(join(root, path)).isSymbolicLink())
      throw Error('Symlink projection directory');
  const parent = join(root, '.generated', 'architecture');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'parse-'));
  try {
    const results: ICruiseResult[] = [];
    for (const runtime of [false, true]) {
      const projection = join(directory, runtime ? 'runtime' : 'public');
      for (const [path, imports] of edges) {
        const file = join(projection, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          imports
            .filter((edge) => !runtime || (!path.endsWith('.d.ts') && !edge.typeOnly))
            .map((edge) => `import ${JSON.stringify(edge.specifier)};`)
            .join('\n') + '\n',
        );
      }
      // JSON resources are data, not executed. Resolve workspace exports through the installed resolver.
      for (const path of paths.filter((path) => /^(apps|packages)\/.*\.(json|css)$/.test(path))) {
        const file = join(projection, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, readFileSync(join(root, path)));
      }
      for (const path of paths.filter((path) =>
        /^(apps|packages)\/[^/]+\/package\.json$/.test(path),
      )) {
        const modules = join(root, dirname(path), 'node_modules');
        if (existsSync(modules)) {
          // Link resolved package roots individually. A junction of node_modules leaves
          // pnpm's relative package links anchored to the projection on Windows.
          for (const entry of readdirSync(modules).filter((name) => !name.startsWith('.'))) {
            const names = entry.startsWith('@')
              ? readdirSync(join(modules, entry)).map((name) => `${entry}/${name}`)
              : [entry];
            for (const name of names) {
              const destination = join(projection, dirname(path), 'node_modules', name);
              mkdirSync(dirname(destination), { recursive: true });
              symlinkSync(
                realpathSync(join(modules, name)),
                destination,
                process.platform === 'win32' ? 'junction' : 'dir',
              );
            }
          }
        }
      }
      const aliases: Record<string, string> = {};
      for (const path of paths.filter((path) => /^packages\/[^/]+\/package\.json$/.test(path))) {
        const pkg = record(JSON.parse(readFileSync(join(root, path), 'utf8')) as unknown);
        const exports =
          typeof pkg.exports === 'string' ? { '.': pkg.exports } : record(pkg.exports);
        for (const [sub, target] of Object.entries(exports)) {
          const entry = text(target);
          if (
            !entry.startsWith('./') ||
            entry.includes('..', 2) ||
            (sub !== '.' && !sub.startsWith('./'))
          )
            throw Error(`Unsupported workspace export: ${path}`);
          aliases[`${text(pkg.name)}${sub === '.' ? '' : sub.slice(1)}$`] = resolve(
            projection,
            dirname(path),
            entry,
          );
        }
      }
      const config = join(projection, 'tsconfig.json');
      const base =
        typeof options.baseUrl === 'string'
          ? options.baseUrl
          : typeof options.pathsBasePath === 'string'
            ? options.pathsBasePath
            : root;
      const sub = relative(root, resolve(root, base));
      if (sub === '..' || sub.startsWith('..' + sep))
        throw Error('Alias base lies outside the project');
      const tsPaths = options.paths === undefined ? {} : record(options.paths);
      for (const targets of Object.values(tsPaths))
        if (
          !Array.isArray(targets) ||
          targets.some(
            (target) =>
              typeof target !== 'string' || relative(root, resolve(base, target)).startsWith('..'),
          )
        )
          throw Error('Unsupported alias target');
      writeFileSync(
        config,
        JSON.stringify({ compilerOptions: { baseUrl: resolve(projection, sub), paths: tsPaths } }),
      );
      const result = await cruise(
        sources,
        {
          baseDir: projection,
          // Keep resolved package-root links stable; workspace aliases are explicit.
          preserveSymlinks: true,
          tsConfig: { fileName: config },
          parser: 'acorn',
          moduleSystems: ['es6'],
          doNotFollow: { path: 'node_modules|[.]css$' },
          extraExtensionsToScan: ['.css'],
          ruleSet: {
            forbidden: runtime
              ? [
                  rule(
                    'no-runtime-cycle',
                    {},
                    { circular: true },
                    'Break runtime cycles; type-only edges are checked in the public graph.',
                  ),
                ]
              : boundaryRules,
          },
          validate: true,
        },
        {
          alias: aliases,
          modules: ['node_modules', join(root, 'node_modules')],
          extensions: ['.ts', '.tsx', '.json', '.js', '.css'],
          extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
          conditionNames: ['import', 'default'],
          exportsFields: ['exports'],
        },
        { tsConfig: { options: { baseUrl: resolve(projection, sub) } } },
      );
      if (typeof result.output === 'string') throw Error('Architecture graph missing');
      if (
        result.output.modules.filter(
          (m) => m.source.startsWith('apps/') || m.source.startsWith('packages/'),
        ).length < sources.length
      )
        throw Error('Architecture source coverage incomplete');
      results.push(result.output);
    }
    return { publicGraph: results[0]!, runtimeGraph: results[1]! };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
