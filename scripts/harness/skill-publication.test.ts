import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindSkillObservation, skillObservationIdentity } from './skill-publication-evidence.ts';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  canonicalJson,
  contentHash,
  revisionIndex,
  revisionReference,
  skillCatalogDigest,
  type SkillResolution,
} from '@fantasy/domain';
import { sampleCatalog } from '@fantasy/samples';
import { completeSkillTestCatalog } from '../../packages/domain/src/skill-system.test-fixtures.ts';
import {
  inspectSkillPublications,
  SKILL_PROOF_KINDS,
  type SkillPublicationLedger,
  type SkillTestExecution,
} from './skill-publication.ts';

const sourceSha = 'a'.repeat(40);
async function candidate(kind: SkillResolution['kind'] = 'active-ability') {
  const revisions = await sampleCatalog(),
    action = revisions.find((entry) => entry.kind === 'ability' && entry.id === 'sword')!,
    passive = revisions.find((entry) => entry.kind === 'ability' && entry.id === 'parry-v1')!,
    replacement = { ...action, revision: action.revision + 1 },
    catalog = completeSkillTestCatalog();
  const recipe: SkillResolution =
    kind === 'augment'
      ? {
          kind,
          baseAbility: revisionReference(action),
          resolvedAbility: revisionReference(replacement),
        }
      : { kind, ability: revisionReference(kind === 'active-ability' ? action : passive) };
  catalog.nodes = catalog.nodes.map((node, index) =>
    index === 0
      ? { ...node, prerequisites: [], resolution: [recipe], fixtureIds: ['fixture.publication'] }
      : { ...node, lifecycle: 'draft', resolution: [], fixtureIds: [] },
  );
  const node = catalog.nodes[0]!,
    catalogRef = {
      id: catalog.id,
      revision: catalog.revision,
      contentHash: await skillCatalogDigest(catalog),
    },
    registry = new Map(
      SKILL_PROOF_KINDS.map((kind) => [
        kind,
        {
          file: 'scripts/harness/skill-publication.test.ts',
          name: `independent ${kind} assertion`,
        },
      ]),
    ),
    ledger: SkillPublicationLedger = {
      schemaVersion: 1,
      historicalCatalogs: [],
      bindings: [
        {
          catalog: catalogRef,
          nodeId: node.id,
          nodeHash: await contentHash(JSON.parse(canonicalJson(node))),
          recipe: node.resolution,
          required: [...SKILL_PROOF_KINDS],
          fixtures: [
            {
              id: 'fixture.publication',
              tests: SKILL_PROOF_KINDS.map((kind) => ({ kind, testId: kind })),
            },
          ],
        },
      ],
    },
    execution: SkillTestExecution = {
      sourceSha,
      complete: true,
      outcomes: new Map(
        [...registry.values()].map((test) => [`${test.file}\n${test.name}`, ['passed']]),
      ),
    };
  return {
    catalogs: [catalog],
    ledger,
    registry,
    lookup: revisionIndex([...revisions, replacement]),
    sourceSha,
    execution,
  };
}
const issues = (report: Awaited<ReturnType<typeof inspectSkillPublications>>) =>
  report.rows[0]!.proof.issues.map(({ code }) => code);

describe('independent skill publication evidence', () => {
  it.each(['active-ability', 'passive-ability', 'augment'] as const)(
    'requires complete, same-source evidence for %s',
    async (kind) => {
      const report = await inspectSkillPublications(await candidate(kind));
      expect(report.newPublicationReady).toBe(true);
      expect(report.rows[0]!.proof).toMatchObject({
        registered: true,
        linked: true,
        passed: true,
        issues: [],
      });
      expect(report.issueCompletion).toBe('requires-existing-issue-completion-gate');
    },
  );
  it.each([
    ['skip', 'pending', 'skipped-test'],
    ['failure', 'failed', 'failed-test'],
    ['missing', null, 'unexecuted-test'],
  ])(
    'rejects required test %s without treating registry membership as execution',
    async (_label, status, expected) => {
      const input = await candidate(),
        ref = input.registry.get('battle')!,
        key = `${ref.file}\n${ref.name}`,
        outcomes = new Map(input.execution.outcomes);
      status === null ? outcomes.delete(key) : outcomes.set(key, [status]);
      const report = await inspectSkillPublications({
        ...input,
        execution: { ...input.execution, outcomes },
      });
      expect(report.newPublicationReady).toBe(false);
      expect(issues(report)).toContain(expected);
      expect(report.rows[0]!.proof.registered).toBe(true);
      expect(report.rows[0]!.proof.linked).toBe(status !== null);
    },
  );
  it('does not pass by copying fixture IDs, registering a filename, or borrowing another SHA', async () => {
    const input = await candidate();
    input.ledger.bindings[0]!.fixtures[0]!.tests = [];
    expect(issues(await inspectSkillPublications(input))).toContain('missing-required-kind');
    const registered = await candidate();
    registered.registry.delete('resolution');
    expect(issues(await inspectSkillPublications(registered))).toContain('unbound-test');
    const fresh = await candidate();
    expect(issues(await inspectSkillPublications({ ...fresh, execution: null }))).toContain(
      'incomplete-run',
    );
    expect(
      issues(
        await inspectSkillPublications({
          ...fresh,
          execution: { ...fresh.execution, sourceSha: 'b'.repeat(40) },
        }),
      ),
    ).toContain('stale-results');
  });
  it('distinguishes structural missing recipes, trigger mismatch and missing exact definitions', async () => {
    const missing = await candidate();
    missing.catalogs[0]!.nodes[0]!.resolution = [];
    await expect(inspectSkillPublications(missing)).rejects.toThrow('requires a resolution');
    const trigger = await candidate('passive-ability');
    const node = trigger.catalogs[0]!.nodes[0]!;
    const recipe = node.resolution[0]!;
    if (recipe.kind !== 'passive-ability') throw new Error('Expected passive fixture');
    node.resolution = [{ kind: 'active-ability', ability: recipe.ability }];
    const report = await inspectSkillPublications(trigger);
    expect(report.rows[0]!.proof.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid-recipe',
          causeCode: 'active-trigger',
          detail: expect.stringContaining('action trigger'),
        }),
      ]),
    );
    const missingDefinition = await candidate();
    const unresolved = await inspectSkillPublications({
      ...missingDefinition,
      lookup: () => undefined,
    });
    expect(unresolved.rows[0]!.proof.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid-recipe',
          causeCode: 'missing-revision',
        }),
      ]),
    );
  });
  it('separates unregistered nodes, fixtures and missing required categories', async () => {
    const input = await candidate();
    input.ledger.bindings[0]!.fixtures = [];
    expect(issues(await inspectSkillPublications(input))).toContain('unregistered-fixture');
    input.ledger.bindings = [];
    const report = await inspectSkillPublications(input);
    expect(issues(report)).toEqual(['unregistered-node']);
    expect(report.newPublicationReady).toBe(false);
  });
  it('binds evidence to exact catalog, node and recipe identities', async () => {
    const input = await candidate();
    input.ledger.bindings[0]!.nodeHash = `sha256:${'0'.repeat(64)}`;
    expect(issues(await inspectSkillPublications(input))).toContain('identity-mismatch');
    input.ledger.bindings[0]!.catalog.revision++;
    expect(issues(await inspectSkillPublications(input))).toContain('unregistered-node');
  });
  it('preserves unproven history without weakening the new publication gate', async () => {
    const input = await candidate();
    input.ledger.historicalCatalogs = [input.ledger.bindings[0]!.catalog];
    input.ledger.bindings = [];
    const audit = await inspectSkillPublications(input);
    expect(audit.newPublicationReady).toBe(true);
    expect(audit.rows[0]).toMatchObject({ mode: 'historical-audit', proof: { passed: false } });
    const next = structuredClone(input.catalogs[0]!);
    next.revision++;
    next.nodes[0]!.name = 'Changed published candidate';
    const report = await inspectSkillPublications({
      ...input,
      catalogs: [...input.catalogs, next],
    });
    expect(report.newPublicationReady).toBe(false);
    expect(report.rows[1]!.mode).toBe('new-publication');
    input.catalogs[0]!.nodes[0]!.name = 'Rewritten history';
    await expect(inspectSkillPublications(input)).rejects.toThrow(
      'Historical catalog content changed',
    );
  });
  it('binds dependency-free CI observations to the same SHA, attempt and definition bytes', async () => {
    const input = await candidate();
    const audit = await inspectSkillPublications({ ...input, execution: null });
    const expected = {
      info: { sourceSha, candidateSha: sourceSha, baselineSha: null, testMergeSha: null },
      runId: '123',
      runAttempt: '2',
      inputs: ['ledger-digest', 'corpus-digest'],
    };
    const observed = {
      schemaVersion: 1,
      producer: 'skill-publication-observer',
      ...expected,
      clean: true,
      audit,
    };
    expect(bindSkillObservation(observed, expected, input.execution).newPublicationReady).toBe(
      true,
    );
    for (const patch of [
      { runAttempt: '1' },
      { runId: '456' },
      { inputs: ['changed'] },
      { clean: false },
      { info: { ...expected.info, sourceSha: 'b'.repeat(40) } },
    ])
      expect(() =>
        bindSkillObservation({ ...observed, ...patch }, expected, input.execution),
      ).toThrow();
    const empty = bindSkillObservation(observed, expected, {
      ...input.execution,
      outcomes: new Map(),
    });
    expect(empty.newPublicationReady).toBe(false);
    expect(empty.rows[0]!.proof.issues.map(({ code }) => code)).toContain('unexecuted-test');
    // Reproduce the aggregate environment: checked-out scripts, no workspace packages/node_modules.
    const temporary = mkdtempSync(join(tmpdir(), 'fantasy-skill-aggregate-'));
    try {
      cpSync('scripts', join(temporary, 'scripts'), { recursive: true });
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "await import('./scripts/harness/skill-publication-evidence.ts')",
        ],
        { cwd: temporary },
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  it('binds the physical source across the sanitized corpus subprocess and PR aggregate environments', () => {
    const expected = skillObservationIdentity(process.cwd()).info;
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
    vi.stubEnv('GITHUB_EVENT_PATH', '/not-forwarded-to-the-safe-subprocess.json');
    try {
      expect(skillObservationIdentity(process.cwd()).info).toEqual(expected);
      expect(expected).toMatchObject({
        candidateSha: expected.sourceSha,
        baselineSha: null,
        testMergeSha: null,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
