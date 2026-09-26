import {
  isCallExpression,
  isIdentifier,
  isStringLiteral,
  isPropertyAccessExpression,
  isArrowFunction,
  isFunctionExpression,
  isFunctionDeclaration,
  isVariableDeclaration,
} from 'typescript/unstable/ast';
import type { Node, SourceFile } from 'typescript/unstable/ast';
import { walk } from './ast.ts';
import type { CapabilityTest } from './capability-contract.ts';

function definitions(root: Node): Map<string, Node[]> {
  const found = new Map<string, Node[]>();
  walk(root, (node) => {
    const name = isVariableDeclaration(node) || isFunctionDeclaration(node) ? node.name : undefined;
    const value = isVariableDeclaration(node) ? node.initializer : node;
    if (name && isIdentifier(name) && value)
      found.set(name.text, [...(found.get(name.text) ?? []), value]);
  });
  return found;
}

/** An exact named test must exercise the declared kind and contain a matcher call.
 * Runtime pass/fail and the meaning of its independent expectations still require verify/review.
 */
export function hasBehavioralEvidence(
  file: SourceFile,
  evidence: CapabilityTest,
  capability: string,
): boolean {
  if (!/\.(?:test|spec)\.tsx?$/.test(evidence.path) || !evidence.name.trim()) return false;
  const bodies: Node[] = [];
  const visit = (node: Node) => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      ['skip', 'todo'].includes(node.expression.name.text)
    )
      return;
    node.forEachChild(visit);
    if (
      !isCallExpression(node) ||
      !isIdentifier(node.expression) ||
      !['it', 'test'].includes(node.expression.text)
    )
      return;
    const [name, callback] = node.arguments;
    if (
      name &&
      isStringLiteral(name) &&
      name.text === evidence.name &&
      callback &&
      (isArrowFunction(callback) || isFunctionExpression(callback))
    )
      bodies.push(callback.body);
  };
  visit(file);
  if (bodies.length !== 1) return false;
  let assertion = false;
  const kind = capability.slice(capability.indexOf(':') + 1);
  const globals = definitions(file),
    locals = definitions(bodies[0]!);
  const related = (node: Node, visited = new Set<Node>()): boolean => {
    if (visited.has(node) || visited.size > 5000) return false;
    visited.add(node);
    if ((isIdentifier(node) || isStringLiteral(node)) && node.text.startsWith(kind)) {
      const suffix = node.text.slice(kind.length);
      if (!suffix || /^[A-Z.-]/.test(suffix)) return true;
    }
    if (isIdentifier(node)) {
      const values = locals.get(node.text) ?? globals.get(node.text);
      return values?.length === 1 && related(values[0]!, visited);
    }
    let found = false;
    node.forEachChild((child) => {
      found ||= related(child, visited);
    });
    return found;
  };
  walk(bodies[0]!, (node) => {
    if (
      !isCallExpression(node) ||
      !isPropertyAccessExpression(node.expression) ||
      !/^to[A-Z]/.test(node.expression.name.text)
    )
      return;
    let receiver: Node = node.expression.expression;
    while (isPropertyAccessExpression(receiver)) receiver = receiver.expression;
    if (
      isCallExpression(receiver) &&
      isIdentifier(receiver.expression) &&
      receiver.expression.text === 'expect'
    )
      assertion ||= receiver.arguments.some((argument) => related(argument));
  });
  return assertion;
}
