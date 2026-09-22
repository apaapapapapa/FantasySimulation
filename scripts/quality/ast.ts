import { API } from 'typescript/unstable/sync';
import {
  isImportDeclaration,
  isExportDeclaration,
  isStringLiteral,
  isNamedImports,
  isNamedExports,
  isImportTypeNode,
  isLiteralTypeNode,
  isCallExpression,
  isIdentifier,
  SyntaxKind,
} from 'typescript/unstable/ast';
import type { Node, SourceFile } from 'typescript/unstable/ast';
import { resolve, relative, sep } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
export interface ImportEdge {
  specifier: string;
  typeOnly: boolean;
}
export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}
/** Parse with the pinned native TS7 API; never fall back to a loose JS parser. */
export function withSources<T>(
  root: string,
  paths: string[],
  use: (sources: Map<string, SourceFile>, options: Record<string, unknown>) => T,
): T {
  if (!paths.length || paths.length > 10000 || new Set(paths).size !== paths.length)
    throw Error('Invalid source coverage');
  const actualRoot = realpathSync(root);
  for (const path of paths) {
    if (!path || path.split(/[\\/]/).some((part) => part === '..' || part === '.' || !part))
      throw Error('Unsafe source path');
    const file = resolve(root, path),
      stat = lstatSync(file),
      rel = relative(actualRoot, realpathSync(file));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 2 * 1024 * 1024 ||
      rel === '..' ||
      rel.startsWith('..' + sep)
    )
      throw Error('Unsafe or oversized source');
  }
  const api = new API({ cwd: root });
  try {
    const config = resolve(root, 'tsconfig.json');
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (!project) throw Error('Native TypeScript project unavailable');
      const sources = new Map<string, SourceFile>();
      for (const path of paths) {
        const file = project.program.getSourceFile(resolve(root, path));
        if (!file) throw Error(`Unparsed source: ${path}`);
        if (project.program.getSyntacticDiagnostics(resolve(root, path)).length)
          throw Error(`Invalid source syntax: ${path}`);
        sources.set(path, file);
      }
      return use(sources, project.compilerOptions as unknown as Record<string, unknown>);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
export function importEdges(file: SourceFile, allowedTypeReference?: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  walk(file, (node) => {
    if (isImportDeclaration(node)) {
      if (!isStringLiteral(node.moduleSpecifier)) throw Error('Nonliteral static import');
      const c = node.importClause,
        bindings = c?.namedBindings;
      const only =
        !!c &&
        (c.phaseModifier === SyntaxKind.TypeKeyword ||
          (!c.name &&
            !!bindings &&
            isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((e) => e.isTypeOnly)));
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly: only });
    } else if (isExportDeclaration(node) && node.moduleSpecifier) {
      if (!isStringLiteral(node.moduleSpecifier)) throw Error('Nonliteral export');
      const clause = node.exportClause;
      edges.push({
        specifier: node.moduleSpecifier.text,
        typeOnly:
          node.isTypeOnly ||
          (!!clause &&
            isNamedExports(clause) &&
            clause.elements.length > 0 &&
            clause.elements.every((e) => e.isTypeOnly)),
      });
    } else if (isImportTypeNode(node)) {
      if (!isLiteralTypeNode(node.argument) || !isStringLiteral(node.argument.literal))
        throw Error('Nonliteral import type');
      edges.push({ specifier: node.argument.literal.text, typeOnly: true });
    } else if (
      isCallExpression(node) &&
      (node.expression.kind === SyntaxKind.ImportKeyword ||
        (isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0];
      if (!argument || !isStringLiteral(argument))
        throw Error('Dynamic module expression needs an explicit boundary');
      edges.push({ specifier: argument.text, typeOnly: false });
    } else if (node.kind === SyntaxKind.ImportEqualsDeclaration)
      throw Error('Import-equals is not part of the ESM workspace contract');
  });
  if (
    file.referencedFiles.length ||
    (file.typeReferenceDirectives.length &&
      !(
        allowedTypeReference &&
        file.typeReferenceDirectives.length === 1 &&
        file.typeReferenceDirectives[0]?.fileName === allowedTypeReference
      ))
  )
    throw Error('Triple-slash module dependencies require an explicit policy');
  return edges;
}
