import {
  isArrowFunction,
  isFunctionDeclaration,
  isFunctionExpression,
  isVariableDeclaration,
  isVariableStatement,
  isPrefixUnaryExpression,
  isBinaryExpression,
  isIdentifier,
  isStringLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isParenthesizedExpression,
  isAsExpression,
  isSatisfiesExpression,
  isBlock,
  isReturnStatement,
  isCallExpression,
  SyntaxKind,
} from 'typescript/unstable/ast';
import type { Node, SourceFile } from 'typescript/unstable/ast';
import { EffectSchema, AttackSchema } from '@fantasy/domain/spatial';
import { walk, withSources } from './ast.ts';
import {
  CAPABILITY_ROLES,
  CAPABILITY_COVERAGE,
  type CapabilityCoverage,
  type CapabilityOwner,
} from './capability-contract.ts';

export const capabilityIds = () => [
  ...EffectSchema.options.map((schema) => `effect:${schema.shape.kind.value}`),
  ...AttackSchema.options.map((schema) => `attack:${schema.shape.kind.value}`),
];
function declaration(file: SourceFile, name: string): Node | undefined {
  const found: Node[] = [];
  walk(file, (node) => {
    if (isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === name)
      if (node.initializer) found.push(node.initializer);
  });
  return found.length === 1 ? found[0] : undefined;
}
function expression(file: SourceFile, node: Node | undefined, depth = 0): Node | undefined {
  if (!node || depth > 8) return undefined;
  if (isParenthesizedExpression(node) || isAsExpression(node) || isSatisfiesExpression(node))
    return expression(file, node.expression, depth + 1);
  if (isIdentifier(node)) return expression(file, declaration(file, node.text), depth + 1);
  return node;
}
function target(file: SourceFile, owner: CapabilityOwner): Node | undefined {
  let node = expression(file, declaration(file, owner.symbol));
  if (owner.member !== undefined) {
    if (!node || !isObjectLiteralExpression(node)) return undefined;
    const matches = node.properties.filter(
      (property) =>
        isPropertyAssignment(property) &&
        (isIdentifier(property.name) || isStringLiteral(property.name)) &&
        property.name.text === owner.member,
    );
    const property = matches.length === 1 ? matches[0] : undefined;
    node = property && isPropertyAssignment(property) ? property.initializer : undefined;
  }
  return expression(file, node);
}
function constant(
  node: Node | undefined,
  locals: ReadonlyMap<string, boolean> = new Map(),
): boolean {
  if (!node) return true;
  if (isParenthesizedExpression(node) || isAsExpression(node) || isSatisfiesExpression(node))
    return constant(node.expression, locals);
  if (isPrefixUnaryExpression(node)) return constant(node.operand, locals);
  if (isBinaryExpression(node)) return constant(node.left, locals) && constant(node.right, locals);
  return (
    node.kind === SyntaxKind.NullKeyword ||
    node.kind === SyntaxKind.TrueKeyword ||
    node.kind === SyntaxKind.FalseKeyword ||
    node.kind === SyntaxKind.NumericLiteral ||
    node.kind === SyntaxKind.StringLiteral ||
    (isIdentifier(node) && (node.text === 'undefined' || locals.get(node.text) === true))
  );
}
function hasImplementation(node: Node | undefined): boolean {
  if (
    !node ||
    !(isFunctionDeclaration(node) || isFunctionExpression(node) || isArrowFunction(node))
  )
    return false;
  const body = node.body;
  if (!body) return false;
  if (!isBlock(body)) return !constant(body);
  const locals = new Map<string, boolean>();
  let substantive = false;
  for (const statement of body.statements) {
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const inert = constant(declaration.initializer, locals);
        if (isIdentifier(declaration.name)) locals.set(declaration.name.text, inert);
        substantive ||= !inert;
      }
    } else if (isReturnStatement(statement)) {
      return substantive || !constant(statement.expression, locals);
    } else if (statement.kind === SyntaxKind.ThrowStatement) {
      return substantive;
    } else if (statement.kind !== SyntaxKind.EmptyStatement) {
      substantive = true;
    }
  }
  return substantive;
}
export type CapabilityFinding = { capability: string; role: string; reason: string };

/** Conservative source/ownership coverage. Behavioral evidence remains in mandatory tests. */
export function inspectCapabilities(
  files: ReadonlyMap<string, SourceFile>,
  coverage: Readonly<Record<string, CapabilityCoverage>>,
  expected: readonly string[],
): CapabilityFinding[] {
  const findings: CapabilityFinding[] = [];
  const add = (capability: string, role: string, reason: string) =>
    findings.push({ capability, role, reason });
  for (const id of new Set([...expected, ...Object.keys(coverage)])) {
    const entry = coverage[id];
    if (!expected.includes(id) || !entry) {
      add(id, 'contract', 'Schema and capability inventory differ');
      continue;
    }
    for (const role of CAPABILITY_ROLES) {
      const responsibility = entry.roles[role];
      if (!responsibility || responsibility.status === 'unsupported') {
        add(id, role, 'Required capability responsibility is missing or unsupported');
        continue;
      }
      const file = files.get(responsibility.owner.path);
      const implementation = file && target(file, responsibility.owner);
      if (!implementation) add(id, role, 'Owning symbol or handler is missing/ambiguous');
      if (responsibility.status === 'implemented') {
        if (!hasImplementation(implementation))
          add(id, role, 'Empty or constant handler is not an implementation');
      } else {
        const delegateFile = files.get(responsibility.delegate.path);
        const destination = delegateFile && target(delegateFile, responsibility.delegate);
        if (!responsibility.reason.trim() || !hasImplementation(destination))
          add(id, role, 'Delegation requires a reason and a nonempty destination');
      }
    }
    if (!entry.tests.length) add(id, 'tests', 'No behavioral test coverage declared');
    for (const path of entry.tests) {
      const file = files.get(path);
      let assertion = false;
      if (file && /\.(?:test|spec)\.tsx?$/.test(path))
        walk(file, (node) => {
          if (
            isCallExpression(node) &&
            isIdentifier(node.expression) &&
            node.expression.text === 'expect'
          )
            assertion = true;
        });
      if (!assertion) add(id, 'tests', `Missing test or assertions: ${path}`);
    }
  }
  return findings;
}

export function capabilityCoverage(root: string, tracked: readonly string[]) {
  const paths = new Set<string>();
  for (const entry of Object.values(CAPABILITY_COVERAGE)) {
    entry.tests.forEach((path) => paths.add(path));
    for (const responsibility of Object.values(entry.roles)) {
      if (responsibility.status === 'unsupported') continue;
      paths.add(responsibility.owner.path);
      if (responsibility.status === 'delegated') paths.add(responsibility.delegate.path);
    }
  }
  const selected = [...paths].filter((path) => tracked.includes(path));
  return withSources(root, selected, (files) =>
    inspectCapabilities(files, CAPABILITY_COVERAGE, capabilityIds()),
  );
}
