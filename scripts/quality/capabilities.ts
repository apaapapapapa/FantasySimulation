import {
  isArrowFunction,
  isFunctionDeclaration,
  isFunctionExpression,
  isVariableDeclaration,
  isVariableStatement,
  isVariableDeclarationList,
  isPrefixUnaryExpression,
  isVoidExpression,
  isBinaryExpression,
  isIdentifier,
  isStringLiteral,
  isObjectLiteralExpression,
  isArrayLiteralExpression,
  isSpreadElement,
  isSpreadAssignment,
  isShorthandPropertyAssignment,
  isComputedPropertyName,
  isConditionalExpression,
  isTemplateExpression,
  isPropertyAssignment,
  isPropertyAccessExpression,
  isElementAccessExpression,
  isParenthesizedExpression,
  isAsExpression,
  isSatisfiesExpression,
  isBlock,
  isReturnStatement,
  isCallExpression,
  isExpressionStatement,
  isIfStatement,
  isWhileStatement,
  isDoStatement,
  isForStatement,
  SyntaxKind,
} from 'typescript/unstable/ast';
import type { Node, SourceFile } from 'typescript/unstable/ast';
import { EffectSchema, AttackSchema } from '@fantasy/domain/spatial';
import { walk, withSources } from './ast.ts';
import { hasBehavioralEvidence } from './capability-evidence.ts';
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
const builtInConstants = new Set([
  'undefined',
  'NaN',
  'Infinity',
  ...[
    'EPSILON',
    'MAX_VALUE',
    'MIN_VALUE',
    'MAX_SAFE_INTEGER',
    'MIN_SAFE_INTEGER',
    'NEGATIVE_INFINITY',
    'POSITIVE_INFINITY',
    'NaN',
  ].map((name) => `Number.${name}`),
  ...['E', 'LN10', 'LN2', 'LOG10E', 'LOG2E', 'PI', 'SQRT1_2', 'SQRT2'].map(
    (name) => `Math.${name}`,
  ),
]);
function builtInConstant(node: Node, locals: ReadonlyMap<string, boolean>): boolean {
  const parts: string[] = [];
  while (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    if (isPropertyAccessExpression(node)) parts.unshift(node.name.text);
    else {
      if (!isStringLiteral(node.argumentExpression)) return false;
      parts.unshift(node.argumentExpression.text);
    }
    node = node.expression;
  }
  if (!isIdentifier(node) || locals.has(node.text)) return false;
  if (node.text !== 'globalThis') parts.unshift(node.text);
  return builtInConstants.has(parts.join('.'));
}
function constant(
  node: Node | undefined,
  locals: ReadonlyMap<string, boolean> = new Map(),
  facts: ReadonlyMap<string, boolean | undefined> = new Map(),
): boolean {
  if (!node) return true;
  if (builtInConstant(node, locals)) return true;
  if (isParenthesizedExpression(node) || isAsExpression(node) || isSatisfiesExpression(node))
    return constant(node.expression, locals, facts);
  if (isPrefixUnaryExpression(node)) return constant(node.operand, locals, facts);
  if (isVoidExpression(node)) return constant(node.expression, locals, facts);
  if (isBinaryExpression(node)) {
    if (!constant(node.left, locals, facts)) return false;
    const selected = truth(node.left, { constants: locals, truth: facts });
    if (
      (node.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken && selected === false) ||
      (node.operatorToken.kind === SyntaxKind.BarBarToken && selected === true)
    )
      return true;
    return constant(node.right, locals, facts);
  }
  if (isConditionalExpression(node)) {
    if (!constant(node.condition, locals, facts)) return false;
    const selected = truth(node.condition, { constants: locals, truth: facts });
    return selected === undefined
      ? constant(node.whenTrue, locals, facts) && constant(node.whenFalse, locals, facts)
      : constant(selected ? node.whenTrue : node.whenFalse, locals, facts);
  }
  if (isTemplateExpression(node))
    return node.templateSpans.every((span) => constant(span.expression, locals, facts));
  if (isSpreadElement(node) || isSpreadAssignment(node))
    return constant(node.expression, locals, facts);
  if (isArrayLiteralExpression(node))
    return node.elements.every((entry) => constant(entry, locals, facts));
  if (isObjectLiteralExpression(node))
    return node.properties.every((property) => {
      if (isSpreadAssignment(property)) return constant(property.expression, locals, facts);
      if (isShorthandPropertyAssignment(property))
        return (
          constant(property.name, locals, facts) &&
          constant(property.objectAssignmentInitializer, locals, facts)
        );
      return (
        isPropertyAssignment(property) &&
        (!isComputedPropertyName(property.name) ||
          constant(property.name.expression, locals, facts)) &&
        constant(property.initializer, locals, facts)
      );
    });
  return (
    node.kind === SyntaxKind.NullKeyword ||
    node.kind === SyntaxKind.TrueKeyword ||
    node.kind === SyntaxKind.FalseKeyword ||
    node.kind === SyntaxKind.NumericLiteral ||
    node.kind === SyntaxKind.BigIntLiteral ||
    node.kind === SyntaxKind.RegularExpressionLiteral ||
    node.kind === SyntaxKind.StringLiteral ||
    node.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    node.kind === SyntaxKind.OmittedExpression ||
    (isIdentifier(node) && locals.get(node.text) === true)
  );
}
type Bindings = { constants: Map<string, boolean>; truth: Map<string, boolean | undefined> };
function truth(
  node: Node | undefined,
  bindings: {
    constants: ReadonlyMap<string, boolean>;
    truth: ReadonlyMap<string, boolean | undefined>;
  },
): boolean | undefined {
  if (!node) return undefined;
  if (isParenthesizedExpression(node) || isAsExpression(node) || isSatisfiesExpression(node))
    return truth(node.expression, bindings);
  if (isIdentifier(node) && bindings.truth.has(node.text)) return bindings.truth.get(node.text);
  if (node.kind === SyntaxKind.FalseKeyword || node.kind === SyntaxKind.NullKeyword) return false;
  if (
    node.kind === SyntaxKind.TrueKeyword ||
    isObjectLiteralExpression(node) ||
    isArrayLiteralExpression(node)
  )
    return true;
  if (isStringLiteral(node)) return node.text.length !== 0;
  if (node.kind === SyntaxKind.NumericLiteral) return Number(node.getText()) !== 0;
  if (isPrefixUnaryExpression(node) && node.operator === SyntaxKind.ExclamationToken) {
    const value = truth(node.operand, bindings);
    return value === undefined ? undefined : !value;
  }
  if (isVoidExpression(node) && constant(node.expression, bindings.constants, bindings.truth))
    return false;
  if (builtInConstant(node, bindings.constants))
    return !/(?:^|[.\"'])(?:NaN|undefined)(?:[\"']\])?$/.test(node.getText());
  return undefined;
}
type Work = { work: boolean; stops: boolean };
function statementsWork(statements: readonly Node[], bindings: Bindings): Work {
  let work = false;
  for (const statement of statements) {
    const next = statementWork(statement, bindings);
    work ||= next.work;
    if (next.stops) return { work, stops: true };
  }
  return { work, stops: false };
}
function statementWork(statement: Node, bindings: Bindings): Work {
  const { constants, truth: truths } = bindings;
  const result = (work: boolean, stops = false): Work => ({ work, stops });
  const branch = (node: Node | undefined) =>
    node
      ? statementWork(node, { constants: new Map(constants), truth: new Map(truths) })
      : result(false);
  if (isBlock(statement)) return statementsWork(statement.statements, bindings);
  if (isVariableStatement(statement) || isVariableDeclarationList(statement)) {
    let work = false;
    const declarations = isVariableStatement(statement)
      ? statement.declarationList.declarations
      : statement.declarations;
    for (const declaration of declarations) {
      const inert = constant(declaration.initializer, constants, truths);
      const value = truth(declaration.initializer, bindings);
      if (isIdentifier(declaration.name)) {
        constants.set(declaration.name.text, inert);
        truths.set(declaration.name.text, value);
      }
      work ||= !inert;
    }
    return result(work);
  }
  if (isReturnStatement(statement))
    return result(!constant(statement.expression, constants, truths), true);
  if (statement.kind === SyntaxKind.ThrowStatement) return result(false, true);
  if (isExpressionStatement(statement))
    return result(!constant(statement.expression, constants, truths));
  if (isIfStatement(statement)) {
    const selected = truth(statement.expression, bindings);
    const conditionWork = !constant(statement.expression, constants, truths);
    if (selected !== undefined) {
      const chosen = branch(selected ? statement.thenStatement : statement.elseStatement);
      return result(conditionWork || chosen.work, chosen.stops);
    }
    const yes = branch(statement.thenStatement),
      no = branch(statement.elseStatement);
    return result(conditionWork || (yes.work && no.work), yes.stops && no.stops);
  }
  if (isWhileStatement(statement) || isForStatement(statement)) {
    const condition = isWhileStatement(statement) ? statement.expression : statement.condition;
    // A loop with a proven false condition never reaches its body or incrementor.
    if (
      condition &&
      constant(condition, constants, truths) &&
      truth(condition, bindings) !== true
    ) {
      const initializer = isForStatement(statement) ? statement.initializer : undefined;
      return result(
        initializer !== undefined &&
          (isVariableDeclarationList(initializer)
            ? statementWork(initializer, bindings).work
            : !constant(initializer, constants, truths)),
      );
    }
    return result(
      branch(statement.statement).work ||
        (condition !== undefined && !constant(condition, constants, truths)),
    );
  }
  if (isDoStatement(statement)) return branch(statement.statement);
  if (isFunctionDeclaration(statement) || statement.kind === SyntaxKind.EmptyStatement)
    return result(false);
  let work = false;
  statement.forEachChild((child) => {
    work ||= statementWork(child, bindings).work;
  });
  return result(work || (isCallExpression(statement) && !constant(statement, constants, truths)));
}
function hasImplementation(node: Node | undefined): boolean {
  if (
    !node ||
    !(isFunctionDeclaration(node) || isFunctionExpression(node) || isArrowFunction(node))
  )
    return false;
  const body = node.body;
  if (!body) return false;
  const locals = new Map<string, boolean>();
  for (const parameter of node.parameters)
    walk(parameter.name, (binding) => {
      if (isIdentifier(binding)) locals.set(binding.text, false);
    });
  if (!isBlock(body)) return !constant(body, locals);
  return statementsWork(body.statements, { constants: locals, truth: new Map() }).work;
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
    for (const evidence of entry.tests) {
      const file = files.get(evidence.path);
      if (!file || !hasBehavioralEvidence(file, evidence, id))
        add(
          id,
          'tests',
          `Missing capability-specific test/assertion: ${evidence.path} :: ${evidence.name}`,
        );
    }
  }
  return findings;
}

export function capabilityCoverage(root: string, tracked: readonly string[]) {
  const paths = new Set<string>();
  for (const entry of Object.values(CAPABILITY_COVERAGE)) {
    entry.tests.forEach(({ path }) => paths.add(path));
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
