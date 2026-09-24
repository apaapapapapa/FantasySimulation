import { resolve, join } from 'node:path';
import { isExportAssignment, isCallExpression, isIdentifier } from 'typescript/unstable/ast';
import { moduleReferences, walk, withSources } from '../quality/ast.ts';
import { contained, json, sourceText } from './files.ts';
import {
  owner,
  packageName,
  runtimePackage,
  workspaceTarget,
  type LockData,
  type RuntimeImport,
} from './dependencies.ts';

export const ENTRY = 'packages/engine/src/spatial/execution.ts';
export const OUTPUT = 'packages/engine/src/spatial/implementation.json';
export function executionClosure(root: string, lock: LockData) {
  return withSources(root, [ENTRY], (_sources, options, checker, program) => {
    if (
      options.module !== 99 ||
      options.moduleResolution !== 100 ||
      options.verbatimModuleSyntax !== true ||
      options.resolveJsonModule !== true ||
      options.paths ||
      options.baseUrl ||
      options.customConditions
    )
      throw Error('Execution identity requires reviewed ESM/Bundler resolution without aliases');
    const sources = new Map<string, string>(),
      imports: RuntimeImport[] = [];
    function visit(path: string): void {
      if (sources.has(path) || path === OUTPUT) return;
      if (
        !/^packages\/(?:engine|domain)\/src\//.test(path) ||
        /(?:^|\/)(?:api|batch|publication|replay|replay-state|sample|catalog|published-rules|tactical-samples)\.ts$/.test(
          path,
        ) ||
        /\.(?:test|d)\.ts$/.test(path)
      )
        throw Error(`Non-execution module in runtime closure: ${path}`);
      if (sources.size >= 10000) throw Error('Execution source closure exceeds bound');
      sources.set(path, sourceText(root, path));
      if (path.endsWith('.json')) {
        JSON.parse(sources.get(path)!);
        return;
      }
      if (!path.endsWith('.ts')) throw Error(`Unsupported execution source: ${path}`);
      const file = program.getSourceFile(resolve(root, path));
      if (!file || program.getSyntacticDiagnostics(resolve(root, path)).length)
        throw Error(`Unparsed execution source: ${path}`);
      const directory = owner(root, path),
        importer = contained(root, directory);
      if (json(join(directory, 'package.json')).type !== 'module')
        throw Error(`Non-ESM execution package: ${importer}`);
      walk(file, (node) => {
        if (
          (isCallExpression(node) &&
            isIdentifier(node.expression) &&
            ['require', 'eval'].includes(node.expression.text)) ||
          (isExportAssignment(node) && node.isExportEquals)
        )
          throw Error(`Unsupported runtime module form: ${path}`);
      });
      for (const edge of moduleReferences(file).filter((edge) => !edge.typeOnly)) {
        const paths = [
          ...new Set(
            checker.getSymbolAtLocation(edge.node)?.declarations.map((node) => node.path) ?? [],
          ),
        ];
        if (paths.length > 1) throw Error(`Ambiguous runtime import: ${path}: ${edge.specifier}`);
        let target: string;
        if (edge.specifier.startsWith('.')) {
          if (!/\.(?:ts|json)$/.test(edge.specifier))
            throw Error(`Explicit runtime extension required: ${edge.specifier}`);
          target = contained(root, resolve(root, path, '..', edge.specifier));
          // Side-effect-only scripts need not have a module symbol; the TS program must still contain them.
          if (!program.getSourceFile(resolve(root, target)))
            throw Error(`Unresolved runtime source: ${target}`);
        } else {
          const name = packageName(edge.specifier);
          if (!paths.length) throw Error(`Unresolved runtime package: ${edge.specifier}`);
          if (!name.startsWith('@fantasy/')) {
            const installed = runtimePackage(root, importer, name);
            if (paths.some((path) => owner(root, path) !== installed))
              throw Error(`Runtime/TypeScript package mismatch: ${edge.specifier}`);
            imports.push({ importer, name });
            continue;
          }
          target = workspaceTarget(root, lock, importer, edge.specifier);
        }
        if (paths.length && contained(root, paths[0]!) !== target)
          throw Error(`Runtime/TypeScript resolution mismatch: ${edge.specifier}`);
        visit(target);
      }
    }
    visit(ENTRY);
    return {
      sources: [...sources.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      imports,
    };
  });
}
