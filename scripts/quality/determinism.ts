import {
  isIdentifier,
  isPropertyAccessExpression,
  isElementAccessExpression,
  isStringLiteral,
  isImportDeclaration,
  isNamedImports,
  isExportDeclaration,
  isPropertyAssignment,
  isCallExpression,
  SyntaxKind,
} from 'typescript/unstable/ast';
import { SymbolFlags } from 'typescript/unstable/sync';
import type { Checker } from 'typescript/unstable/sync';
import type { SourceFile } from 'typescript/unstable/ast';
import { walk } from './ast.ts';
export interface Finding {
  path: string;
  line: number;
  rule: string;
  reason: string;
}
const globals = new Set([
  'Date',
  'crypto',
  'Atomics',
  'SharedArrayBuffer',
  'WeakRef',
  'FinalizationRegistry',
  'Intl',
  'console',
  'performance',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'process',
  'Bun',
  'Deno',
  'eval',
  'Function',
  'globalThis',
  'window',
  'self',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
]);
/** A conservative AST policy for engine code, not proof of mathematical determinism. */
export function determinism(path: string, file: SourceFile, checker: Checker): Finding[] {
  const findings: Finding[] = [];
  walk(file, (node) => {
    const add = (rule: string, reason: string) =>
      findings.push({
        path,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        rule,
        reason,
      });
    if (
      isIdentifier(node) &&
      globals.has(node.text) &&
      !(isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(
        (isPropertyAssignment(node.parent) && node.parent.name === node) ||
        node.parent.kind === SyntaxKind.PropertySignature
      ) &&
      !checker.resolveName(node.text, SymbolFlags.Value, node, true)
    )
      add(
        'no-implicit-environment',
        `${node.text} is not an engine input; use manifest/seed/runner boundaries.`,
      );
    if (isIdentifier(node) && node.text === 'Math') {
      const parent = node.parent;
      if (isPropertyAccessExpression(parent) && parent.expression === node) {
        if (parent.name.text === 'random')
          add('seeded-random-only', 'Use the explicit versioned PRNG, not Math.random.');
      } else if (
        isElementAccessExpression(parent) &&
        parent.expression === node &&
        isStringLiteral(parent.argumentExpression)
      ) {
        if (parent.argumentExpression.text === 'random')
          add('seeded-random-only', 'Computed Math.random is still implicit randomness.');
      } else
        add(
          'no-math-alias',
          'Use direct statically named Math members; aliases/dynamic keys conceal random access.',
        );
    }
    if (
      (isExportDeclaration(node) &&
        node.moduleSpecifier &&
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'node:crypto' &&
        !node.isTypeOnly) ||
      (isCallExpression(node) &&
        (node.expression.kind === SyntaxKind.ImportKeyword ||
          (isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments.some((a) => isStringLiteral(a) && a.text === 'node:crypto'))
    )
      add(
        'pure-hash-only',
        'Use a static named createHash import; crypto namespace access and reexports are not allowed.',
      );
    if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec === 'node:crypto') {
        const clause = node.importClause,
          bindings = clause?.namedBindings;
        if (
          !clause ||
          clause.name ||
          !bindings ||
          !isNamedImports(bindings) ||
          bindings.elements.length === 0 ||
          bindings.elements.some((e) => (e.propertyName?.text ?? e.name.text) !== 'createHash')
        )
          add(
            'pure-hash-only',
            'Only named createHash is allowed from node:crypto; entropy sources belong outside the engine.',
          );
      } else if (
        !spec.startsWith('.') &&
        !(spec === '@fantasy/domain' || spec.startsWith('@fantasy/domain/')) &&
        !(spec === '@dimforge/rapier3d-compat' && path === 'packages/engine/src/spatial/physics.ts')
      )
        add(
          'engine-dependency-policy',
          `Review the deterministic dependency boundary before importing ${spec}.`,
        );
    }
  });
  return findings;
}
