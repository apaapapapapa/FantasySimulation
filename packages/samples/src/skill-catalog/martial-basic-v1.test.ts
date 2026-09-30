import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { SKILL_DANS, SKILL_ZODIAC_IDS } from '@fantasy/domain';
import { martialBasicSkillEvidence, martialBasicSkillShards } from './martial-basic-v1.ts';

type CatalogRecord = {
  id: string;
  revision: number;
  contentHash: string;
};

const repositoryFile = (relativePath: string) =>
  fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url));

describe('basic martial skill catalog authoring', () => {
  it('defines every sword, archery and shield coordinate exactly once', () => {
    expect(martialBasicSkillShards.map(({ path }) => path)).toEqual(['sword', 'archery', 'shield']);

    const nodes = martialBasicSkillShards.flatMap(({ nodes }) => nodes);
    expect(nodes).toHaveLength(216);
    expect(new Set(nodes.map(({ id }) => id)).size).toBe(216);
    expect(new Set(nodes.map(({ coordinate }) => JSON.stringify(coordinate))).size).toBe(216);

    for (const shard of martialBasicSkillShards) {
      expect(shard.nodes).toHaveLength(72);
      for (const zodiac of SKILL_ZODIAC_IDS) {
        const branch = shard.nodes.filter((node) => node.coordinate.zodiac === zodiac);
        expect(branch.map(({ coordinate }) => coordinate.dan)).toEqual(
          SKILL_DANS.map(({ dan }) => dan),
        );
        expect(branch[0]?.prerequisites).toEqual([]);
        for (let index = 1; index < branch.length; index += 1)
          expect(branch[index]?.prerequisites).toEqual([branch[index - 1]?.id]);
      }
    }
  });

  it('authors distinct progression with retained lower uses and explicit upper costs', () => {
    for (const shard of martialBasicSkillShards) {
      const names = shard.nodes.map(({ name }) => name);
      expect(new Set(names).size).toBe(72);
      expect(names.join(' ')).not.toMatch(/\b(?:todo|placeholder|draft)\b/i);

      for (const zodiac of SKILL_ZODIAC_IDS) {
        const branch = shard.nodes.filter((node) => node.coordinate.zodiac === zodiac);
        expect(new Set(branch.map(({ description }) => description)).size).toBe(6);
        expect(new Set(branch.map(({ deepening }) => deepening.explanation)).size).toBe(6);
        expect(branch.every(({ deepening }) => deepening.retainsLowerUse)).toBe(true);
        expect(
          branch
            .filter(({ coordinate }) => coordinate.dan >= 5)
            .every(({ deepening }) => Boolean(deepening.conditionOrTradeoff)),
        ).toBe(true);
      }
    }
  });

  it('keeps lifecycle promotion aligned with machine-readable evidence', () => {
    const nodes = new Map(
        martialBasicSkillShards.flatMap(({ nodes }) => nodes.map((node) => [node.id, node])),
      ),
      evidenceIssues: string[] = [];
    expect(martialBasicSkillEvidence).toHaveLength(216);

    for (const { nodeId, evidence } of martialBasicSkillEvidence) {
      const node = nodes.get(nodeId);
      if (!node) {
        evidenceIssues.push(`${nodeId}: missing node`);
        continue;
      }
      if (evidence.status === 'proven') {
        if (node.lifecycle !== 'available') evidenceIssues.push(`${nodeId}: not available`);
        if (node.resolution.length !== 1) evidenceIssues.push(`${nodeId}: missing resolution`);
        if (!node.fixtureIds.length) evidenceIssues.push(`${nodeId}: missing fixture`);
      } else if (evidence.status === 'definition-only') {
        if (node.lifecycle !== 'implemented') evidenceIssues.push(`${nodeId}: not implemented`);
        if (!evidence.releaseBlocker) evidenceIssues.push(`${nodeId}: missing release blocker`);
      } else {
        if (node.lifecycle !== 'draft') evidenceIssues.push(`${nodeId}: not draft`);
        if (node.resolution.length) evidenceIssues.push(`${nodeId}: premature resolution`);
        if (node.fixtureIds.length) evidenceIssues.push(`${nodeId}: premature fixture`);
        if (!evidence.mechanismIds.length) evidenceIssues.push(`${nodeId}: no missing mechanism`);
        if (!evidence.releaseBlocker) evidenceIssues.push(`${nodeId}: missing release blocker`);
      }
    }
    expect(evidenceIssues).toEqual([]);

    const available = [...nodes.values()].filter(({ lifecycle }) => lifecycle === 'available');
    expect(available.map(({ id }) => id)).toEqual([
      ...SKILL_DANS.map(({ dan }) => `skill.sword.rat.${dan}`),
      'skill.shield.ox.1',
    ]);
    expect(
      [...nodes.values()].filter(
        ({ coordinate, lifecycle }) => coordinate.path === 'archery' && lifecycle === 'available',
      ),
    ).toEqual([]);
  });

  it('pins executable references to the current catalog and named fixtures', () => {
    const catalog = JSON.parse(
      readFileSync(repositoryFile('data/spatial/catalog.json'), 'utf8'),
    ) as CatalogRecord[];
    const corpus = JSON.parse(
        readFileSync(repositoryFile('packages/engine/fixtures/spatial/corpus.json'), 'utf8'),
      ) as { tests: Record<string, unknown> },
      evidenceIssues: string[] = [];
    for (const { evidence } of martialBasicSkillEvidence) {
      if (evidence.status === 'missing-mechanism') continue;
      if (
        !catalog.some(
          (record) =>
            record.id === evidence.ability.id &&
            record.revision === evidence.ability.revision &&
            record.contentHash === evidence.ability.contentHash,
        )
      )
        evidenceIssues.push(`${evidence.ability.id}: catalog reference mismatch`);
      const evidenceSources = evidence.evidenceFiles.map((evidenceFile) =>
        readFileSync(repositoryFile(evidenceFile), 'utf8'),
      );
      for (const fixtureId of evidence.fixtureIds) {
        if (evidence.status === 'proven') {
          const swordFixture = /^fixture\.skill\.sword\.rat\.[1-6]\.action$/.test(fixtureId),
            shieldGuardFixture =
              /^fixture\.skill\.shield\.ox\.1\.guard-(?:battle|replay|viewer)$/.test(fixtureId);
          if (!swordFixture && !shieldGuardFixture)
            evidenceIssues.push(`${fixtureId}: unexpected proven fixture`);
          if (
            swordFixture &&
            !evidenceSources.join('\n').includes('`fixture.skill.sword.rat.${dan}.action`')
          )
            evidenceIssues.push(`${fixtureId}: fixture generator not evidenced`);
          if (shieldGuardFixture && !evidenceSources.join('\n').includes(fixtureId))
            evidenceIssues.push(`${fixtureId}: exact fixture not evidenced`);
        } else if (!(fixtureId in corpus.tests) && !evidenceSources.join('\n').includes(fixtureId))
          evidenceIssues.push(`${fixtureId}: missing corpus fixture`);
      }
    }
    expect(evidenceIssues).toEqual([]);
  });
});
