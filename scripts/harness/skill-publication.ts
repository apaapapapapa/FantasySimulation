import { z } from 'zod';
import {
  HashSchema,
  IdSchema,
  RefSchema,
  SkillResolutionSchema,
  canonicalJson,
  contentHash,
  parseCompleteSkillCatalog,
  revisionRefKey,
  revisionHash,
  skillResolutionAbilityRefs,
  skillCatalogDigest,
  type SkillCatalog,
  type SkillNode,
} from '@fantasy/domain';
import {
  resolveSkillRecipe,
  SkillRecipeError,
} from '../../packages/domain/src/spatial/skill-recipe.ts';
import {
  RevisionGraphError,
  type RevisionLookup,
} from '../../packages/domain/src/spatial/revision-graph.ts';
import type { TestRef } from './corpus-checks.ts';
import { sha } from './report.ts';

/** Publication requires the same vertical categories for every new production node. */
export const SKILL_PROOF_KINDS = [
  'resolution',
  'battle',
  'ai',
  'interaction',
  'persistence',
  'replay',
  'ui',
] as const;
const ProofKindSchema = z.enum(SKILL_PROOF_KINDS);
const BindingSchema = z.strictObject({
  catalog: RefSchema,
  nodeId: IdSchema,
  nodeHash: HashSchema,
  recipe: z.array(SkillResolutionSchema).min(1).max(8),
  required: z
    .array(ProofKindSchema)
    .min(1)
    .max(SKILL_PROOF_KINDS.length)
    .refine((values) => new Set(values).size === values.length, 'Duplicate proof kind'),
  fixtures: z
    .array(
      z.strictObject({
        id: IdSchema,
        tests: z.array(z.strictObject({ kind: ProofKindSchema, testId: IdSchema })).max(64),
      }),
    )
    .max(16)
    .refine(
      (values) => new Set(values.map(({ id }) => id)).size === values.length,
      'Duplicate fixture',
    ),
});
/** Extension of ADR 0020's fixture matrix; executable test identifiers use the existing corpus registry. */
export const SkillPublicationLedgerSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    historicalCatalogs: z.array(RefSchema).max(1000),
    bindings: z.array(BindingSchema).max(16_384),
  })
  .superRefine((ledger, context) => {
    const keys = ledger.bindings.map((entry) => `${revisionRefKey(entry.catalog)}:${entry.nodeId}`);
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: 'custom', message: 'Duplicate node publication binding' });
    const history = ledger.historicalCatalogs.map((entry) => `${entry.id}@${entry.revision}`);
    if (new Set(history).size !== history.length)
      context.addIssue({ code: 'custom', message: 'Duplicate historical catalog revision' });
  });
export type SkillPublicationLedger = z.infer<typeof SkillPublicationLedgerSchema>;
export type { SkillTestExecution } from './skill-publication-proof.ts';
import {
  bindSkillProof,
  type SkillProofIssue,
  type SkillNodeProof,
  type SkillTestExecution,
} from './skill-publication-proof.ts';

async function inspectNode(
  catalog: z.infer<typeof RefSchema>,
  node: SkillNode,
  ledger: SkillPublicationLedger,
  registry: ReadonlyMap<string, TestRef>,
  lookup: RevisionLookup,
  sourceSha: string,
  execution: SkillTestExecution | null,
): Promise<SkillNodeProof> {
  const issues: SkillProofIssue[] = [],
    binding = ledger.bindings.find(
      (entry) =>
        entry.nodeId === node.id && revisionRefKey(entry.catalog) === revisionRefKey(catalog),
    );
  if (!node.resolution.length) issues.push({ code: 'missing-recipe', detail: node.id });
  for (const recipe of node.resolution) {
    try {
      resolveSkillRecipe(recipe, lookup);
      for (const reference of skillResolutionAbilityRefs([recipe])) {
        const definition = lookup('ability', reference);
        if (!definition || definition.contentHash !== (await revisionHash(definition)))
          throw new Error(`Definition content hash mismatch: ${reference.id}`);
      }
    } catch (error) {
      issues.push({
        code: 'invalid-recipe',
        causeCode:
          error instanceof SkillRecipeError || error instanceof RevisionGraphError
            ? error.code
            : 'definition-content-hash',
        detail: error instanceof Error ? error.message : 'invalid definition',
      });
    }
  }
  const proof: SkillNodeProof = {
    nodeId: node.id,
    registered: !!binding,
    linked: false,
    passed: false,
    required: SKILL_PROOF_KINDS,
    tests: [],
    issues,
  };
  if (!binding) {
    issues.push({ code: 'unregistered-node', detail: node.id });
    return proof;
  }
  if (
    binding.nodeHash !== (await contentHash(JSON.parse(canonicalJson(node)))) ||
    canonicalJson(binding.recipe) !== canonicalJson(node.resolution)
  )
    issues.push({ code: 'identity-mismatch', detail: node.id });
  for (const fixtureId of node.fixtureIds)
    if (!binding.fixtures.some(({ id }) => id === fixtureId))
      issues.push({ code: 'unregistered-fixture', detail: fixtureId });
  for (const kind of SKILL_PROOF_KINDS)
    if (
      !binding.required.includes(kind) ||
      !binding.fixtures.some(
        (fixture) =>
          node.fixtureIds.includes(fixture.id) && fixture.tests.some((test) => test.kind === kind),
      )
    )
      issues.push({ code: 'missing-required-kind', detail: kind });
  const tests = binding.fixtures
    .filter(({ id }) => node.fixtureIds.includes(id))
    .flatMap(({ tests }) => tests);
  for (const test of tests) {
    const ref = registry.get(test.testId);
    if (!ref) issues.push({ code: 'unbound-test', detail: test.testId });
    else proof.tests.push({ id: test.testId, ...ref });
  }
  return bindSkillProof(proof, sourceSha, execution);
}

/** Audit history without rewriting it; only new/changed available nodes are publication candidates. */
export async function inspectSkillPublications(input: {
  catalogs: SkillCatalog[];
  ledger: unknown;
  registry: ReadonlyMap<string, TestRef>;
  lookup: RevisionLookup;
  sourceSha: string;
  execution: SkillTestExecution | null;
}) {
  const sourceSha = sha(input.sourceSha),
    ledger = SkillPublicationLedgerSchema.parse(input.ledger),
    rows: Array<{
      catalog: z.infer<typeof RefSchema>;
      mode: 'historical-audit' | 'new-publication';
      proof: SkillNodeProof;
    }> = [],
    seen = new Set<string>(),
    previous = new Map<string, SkillCatalog>();
  for (const catalogInput of input.catalogs) {
    const catalog = parseCompleteSkillCatalog(catalogInput),
      reference = {
        id: catalog.id,
        revision: catalog.revision,
        contentHash: await skillCatalogDigest(catalog),
      },
      key = `${catalog.id}@${catalog.revision}`,
      parent = previous.get(catalog.id),
      historical = ledger.historicalCatalogs.find(
        (ref) => ref.id === catalog.id && ref.revision === catalog.revision,
      );
    if (seen.has(key) || (parent && parent.revision >= catalog.revision))
      throw new Error('Catalog release order or revision conflict');
    if (historical && revisionRefKey(historical) !== revisionRefKey(reference))
      throw new Error('Historical catalog content changed');
    seen.add(key);
    for (const node of catalog.nodes) {
      if (node.lifecycle !== 'available') continue;
      const former = parent?.nodes.find(({ id }) => id === node.id);
      if (!historical && former && canonicalJson(former) === canonicalJson(node)) continue;
      rows.push({
        catalog: reference,
        mode: historical ? 'historical-audit' : 'new-publication',
        proof: await inspectNode(
          reference,
          node,
          ledger,
          input.registry,
          input.lookup,
          sourceSha,
          input.execution,
        ),
      });
    }
    previous.set(catalog.id, catalog);
  }
  if (ledger.historicalCatalogs.some((ref) => !seen.has(`${ref.id}@${ref.revision}`)))
    throw new Error('Missing historical catalog release');
  const candidates = rows.filter(({ mode }) => mode === 'new-publication');
  return {
    sourceSha,
    rows,
    newPublicationReady: candidates.every(({ proof }) => proof.passed),
    // Full issue acceptance is owned by the existing issue-completion harness, never this release gate.
    issueCompletion: 'requires-existing-issue-completion-gate' as const,
  };
}
