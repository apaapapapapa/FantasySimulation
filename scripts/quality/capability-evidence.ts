import {
  isCallExpression,
  isIdentifier,
  isStringLiteral,
  isPropertyAccessExpression,
  isArrowFunction,
  isFunctionExpression,
} from 'typescript/unstable/ast';
import type { Node, SourceFile } from 'typescript/unstable/ast';
import { walk } from './ast.ts';
import type { CapabilityTest } from './capability-contract.ts';

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
  let referencesKind = false,
    assertion = false;
  const kind = capability.slice(capability.indexOf(':') + 1);
  walk(bodies[0]!, (node) => {
    // Include recorded event kinds (projectile-spawn) and kind-specific helpers (meleeTrace).
    if ((isIdentifier(node) || isStringLiteral(node)) && node.text.startsWith(kind)) {
      const suffix = node.text.slice(kind.length);
      if (!suffix || /^[A-Z.-]/.test(suffix)) referencesKind = true;
    }
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
      assertion = true;
  });
  return referencesKind && assertion;
}
