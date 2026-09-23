import { createHash } from 'node:crypto';
import {
  isIdentifier,
  isStringLiteral,
  isPrefixUnaryExpression,
  isPostfixUnaryExpression,
  SyntaxKind,
} from 'typescript/unstable/ast';
import type { Node, SourceFile } from 'typescript/unstable/ast';
import { withSources } from './ast.ts';
import { firstPartyTypeScript } from './files.ts';

// These are reviewed policy, not a growing baseline or a percentage allowance.
export const DUPLICATION_POLICY = Object.freeze({
  minNodes: 40,
  minLines: 8,
  maxSourceNodes: 250000,
  maxRepositoryNodes: 500000,
  maxComparisons: 1000000,
});
interface Token {
  key: string;
  startLine: number;
  endLine: number;
}
interface Location {
  path: string;
  startLine: number;
  endLine: number;
}
export interface DuplicateFinding {
  source: Location;
  destination: Location;
  nodes: number;
  correction: string;
}

/** Preorder fragments retain operators, names and literals, but not formatting/comments. */
function tokens(file: SourceFile): Token[] {
  const result: Token[] = [];
  function visit(node: Node): void {
    if (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.ExportDeclaration)
      return;
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    if (node.kind !== SyntaxKind.SourceFile && node.kind !== SyntaxKind.EndOfFile) {
      const value = children.length
        ? ''
        : isStringLiteral(node) || isIdentifier(node)
          ? node.text
          : node.getText(file);
      const operator =
        isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node) ? node.operator : null;
      const declarationFlags = node.kind === SyntaxKind.VariableDeclarationList ? node.flags : null;
      const start = node.getStart(file);
      result.push({
        key: JSON.stringify([node.kind, children.length, operator, declarationFlags, value]),
        startLine: file.getLineAndCharacterOfPosition(start).line + 1,
        // A partial match ending at a parent must not claim its unmatched children.
        endLine:
          file.getLineAndCharacterOfPosition(
            children.length ? start : Math.max(start, node.end - 1),
          ).line + 1,
      });
      if (result.length > DUPLICATION_POLICY.maxSourceNodes)
        throw Error('Duplication source node budget exceeded');
    }
    children.forEach(visit);
  }
  visit(file);
  return result;
}

/** Exact structural fragments, not a proof of semantic equivalence or absence of all clones. */
export function duplication(root: string, paths: readonly string[]): DuplicateFinding[] {
  const selected = firstPartyTypeScript(paths).sort();
  return withSources(root, selected, (files) => {
    let nodes = 0;
    const sources = [...files].map(([path, file]) => {
      const sequence = tokens(file);
      nodes += sequence.length;
      if (nodes > DUPLICATION_POLICY.maxRepositoryNodes)
        throw Error('Duplication repository node budget exceeded');
      return { path, tokens: sequence };
    });
    const windows = new Map<string, { file: number; offset: number }[]>();
    const findings: DuplicateFinding[] = [];
    const { minNodes, minLines } = DUPLICATION_POLICY;
    let comparisons = 0;
    const equal = (left: Token, right: Token) => {
      if (++comparisons > DUPLICATION_POLICY.maxComparisons)
        throw Error('Duplication comparison budget exceeded');
      return left.key === right.key;
    };
    for (const [file, source] of sources.entries()) {
      const current = source.tokens;
      for (let offset = 0; offset <= current.length - minNodes; offset++) {
        const signature = createHash('sha256')
          .update(
            JSON.stringify(current.slice(offset, offset + minNodes).map((token) => token.key)),
          )
          .digest('hex');
        const matches = windows.get(signature) ?? [];
        for (const previous of matches) {
          const other = sources[previous.file]!;
          const start = previous.offset;
          if (previous.file === file && start + minNodes > offset) continue;
          // Verify the whole window, so hash collisions can never become a finding.
          if (
            !current
              .slice(offset, offset + minNodes)
              .every((token, i) => equal(token, other.tokens[start + i]!))
          )
            continue;
          if (start > 0 && offset > 0 && equal(current[offset - 1]!, other.tokens[start - 1]!))
            continue;
          let count = minNodes;
          while (
            offset + count < current.length &&
            start + count < other.tokens.length &&
            (previous.file !== file || start + count < offset) &&
            equal(current[offset + count]!, other.tokens[start + count]!)
          )
            count++;
          const location = (path: string, sequence: Token[], first: number): Location => ({
            path,
            startLine: sequence[first]!.startLine,
            endLine: sequence[first + count - 1]!.endLine,
          });
          const a = location(other.path, other.tokens, start);
          const b = location(source.path, current, offset);
          if (Math.min(a.endLine - a.startLine + 1, b.endLine - b.startLine + 1) < minLines)
            continue;
          findings.push({
            source: a,
            destination: b,
            nodes: count,
            correction:
              'Reuse the owning module or a test-only fixture; keep independent assertions. Do not add exclusions or raise the threshold to hide this clone.',
          });
        }
        matches.push({ file, offset });
        windows.set(signature, matches);
      }
    }
    return findings;
  });
}
