import {
  RevisionSchema,
  compareIds,
  inspectSkillCatalogRelease,
  parseJson,
  revisionReference,
  skillResolutionAbilityRefs,
  type Revision,
  type SkillCatalog,
  type SkillCatalogReleaseReport,
  type SkillDan,
} from '@fantasy/domain';
import { assembleSkillCatalogReleases } from './skill-catalog-releases.ts';
import { STARTUP_SKILL_CATALOG_RELEASES } from './startup-skill-catalog-releases.ts';
export { STARTUP_SKILL_CATALOG_RELEASES } from './startup-skill-catalog-releases.ts';

const swordRatRelease = [
  {
    dan: 1,
    abilityId: 'sword',
    abilityRevision: 1,
    abilityHash: 'sha256:57dba4284d2a6b5edfeaf6e254ac3e9ed62496b646a6d6e2b658134399892fef',
  },
  {
    dan: 2,
    abilityId: 'stamina-strike-v1',
    abilityRevision: 1,
    abilityHash: 'sha256:d516c37829bbc6708998e73ba9ed58538d42a67495ff4b2ffd8b1e4b686671fc',
  },
  {
    dan: 3,
    abilityId: 'return-cut-v1',
    abilityRevision: 1,
    abilityHash: 'sha256:396d51406e90fb6d783f0b9037d39f6bcd7f8c034624096c90db34edf3934b7f',
  },
  {
    dan: 4,
    abilityId: 'dash-cut-v1',
    abilityRevision: 1,
    abilityHash: 'sha256:83b5bde59f56974f3d5296cab92ad3ecab7ada9524e5acea37208c083cc8c20c',
  },
  {
    dan: 5,
    abilityId: 'wide-sweep-v1',
    abilityRevision: 1,
    abilityHash: 'sha256:aed1d678df594a94b60acf1a0d6ba191ac41a9e8c1da84703dd4dfaae8622a18',
  },
  {
    dan: 6,
    abilityId: 'wide-sweep-trained-v1',
    abilityRevision: 1,
    abilityHash: 'sha256:bab5ea0a1fcd1fc011581c516ec78303c61ba5c7ac7f85dda18e515aa789e76a',
  },
] as const satisfies readonly {
  dan: SkillDan;
  abilityId: string;
  abilityRevision: number;
  abilityHash: string;
}[];

export const STARTUP_SKILL_FIXTURE_IDS = swordRatRelease.map(
  ({ dan }) => `fixture.skill.sword.rat.${dan}.action`,
);

function abilityRevisions(input: unknown[]): Map<string, Extract<Revision, { kind: 'ability' }>> {
  const revisions = parseJson(RevisionSchema.array(), input),
    abilities = new Map<string, Extract<Revision, { kind: 'ability' }>>();
  for (const revision of revisions)
    if (revision.kind === 'ability') abilities.set(`${revision.id}@${revision.revision}`, revision);
  for (const entry of swordRatRelease) {
    const ability = abilities.get(`${entry.abilityId}@${entry.abilityRevision}`);
    if (!ability) throw new Error(`Missing startup skill ability: ${entry.abilityId}`);
    if (ability.contentHash !== entry.abilityHash)
      throw new Error(`Changed startup skill ability: ${entry.abilityId}`);
    if (ability.definition.trigger !== 'action')
      throw new Error(`Startup skill ability is not an action: ${entry.abilityId}`);
  }
  if (new Set(swordRatRelease.map(({ abilityId }) => abilityId)).size !== swordRatRelease.length)
    throw new Error('Startup skill abilities must be unique');
  return abilities;
}

function readHistoricalCatalogs(): SkillCatalog[] {
  return assembleSkillCatalogReleases(STARTUP_SKILL_CATALOG_RELEASES);
}

/** Read every published revision from one immutable release list, independently of authoring. */
export function readStartupSkillCatalogs(revisionInput: unknown[]): SkillCatalog[] {
  abilityRevisions(revisionInput);
  const catalogs = readHistoricalCatalogs();
  for (const catalog of catalogs) validateIntegratedDefinitions(catalog, revisionInput);
  return catalogs;
}

function readReleasedCatalog(revisionInput: unknown[], revision: number): SkillCatalog {
  abilityRevisions(revisionInput);
  const catalog = readHistoricalCatalogs().find((entry) => entry.revision === revision);
  if (!catalog) throw new Error(`Unknown startup skill catalog revision: ${revision}`);
  validateIntegratedDefinitions(catalog, revisionInput);
  return catalog;
}

/** Historical v1 return ordering is retained; persistence uses the existing normalization. */
export function readStartupSkillCatalog(revisionInput: unknown[]): SkillCatalog {
  return readReleasedCatalog(revisionInput, 1);
}

export function inspectStartupSkillCatalog(
  catalog: SkillCatalog,
  revisionInput: unknown[],
): SkillCatalogReleaseReport {
  const abilities = abilityRevisions(revisionInput),
    report = inspectSkillCatalogRelease(catalog, {
      definitionRefs: swordRatRelease
        .map(({ abilityId, abilityRevision }) =>
          revisionReference(abilities.get(`${abilityId}@${abilityRevision}`)!),
        )
        .sort((a, b) => compareIds(a.id, b.id)),
      fixtureIds: [...STARTUP_SKILL_FIXTURE_IDS],
    });
  if (
    report.available !== 6 ||
    report.verified !== 6 ||
    report.lifecycle.draft !== 1_146 ||
    report.issues.length
  )
    throw new Error('Startup skill catalog release evidence is incomplete');
  return report;
}

export const STARTUP_SKILL_ABILITY_IDS = swordRatRelease.map(({ abilityId }) => abilityId);

export const INTEGRATED_STARTUP_CATALOG_V2_REVISION = 2;
export const INTEGRATED_STARTUP_CATALOG_V3_REVISION = 3;
export const PREVIOUS_INTEGRATED_STARTUP_CATALOG_REVISION = 4;
export const INTEGRATED_STARTUP_CATALOG_V5_REVISION = 5;
export const INTEGRATED_STARTUP_CATALOG_V6_REVISION = 6;
export const INTEGRATED_STARTUP_CATALOG_V7_REVISION = 7;
export const INTEGRATED_STARTUP_CATALOG_V8_REVISION = 8;
export const INTEGRATED_STARTUP_CATALOG_V9_REVISION = 9;
export const INTEGRATED_STARTUP_CATALOG_REVISION =
  STARTUP_SKILL_CATALOG_RELEASES.at(-1)!.reference.revision;

function validateIntegratedDefinitions(catalog: SkillCatalog, revisionInput: unknown[]) {
  const revisions = parseJson(RevisionSchema.array(), revisionInput),
    abilities = new Map(
      revisions
        .filter(
          (revision): revision is Extract<Revision, { kind: 'ability' }> =>
            revision.kind === 'ability',
        )
        .map((revision) => [`${revision.id}@${revision.revision}`, revision]),
    ),
    refs = catalog.nodes.flatMap((node) => skillResolutionAbilityRefs(node.resolution));
  for (const ref of refs) {
    const ability = abilities.get(`${ref.id}@${ref.revision}`);
    if (!ability || ability.contentHash !== ref.contentHash)
      throw new Error(`Integrated skill definition is missing or changed: ${ref.id}`);
  }
  return refs;
}

export function readIntegratedStartupSkillCatalogV2(revisionInput: unknown[]): SkillCatalog {
  return readReleasedCatalog(revisionInput, 2);
}

export function readIntegratedStartupSkillCatalogV3(revisionInput: unknown[]): SkillCatalog {
  return readReleasedCatalog(revisionInput, 3);
}

export function readPreviousIntegratedStartupSkillCatalog(revisionInput: unknown[]): SkillCatalog {
  return readReleasedCatalog(revisionInput, 4);
}

export function readIntegratedStartupSkillCatalogV5(revisionInput: unknown[]): SkillCatalog {
  return readReleasedCatalog(revisionInput, 5);
}

export function readIntegratedStartupSkillCatalogV6(revisionInput: unknown[]): SkillCatalog {
  return readReleasedCatalog(revisionInput, 6);
}

export function readIntegratedStartupSkillCatalogV7(revisionInput: unknown[]): SkillCatalog {
  return readReleasedCatalog(revisionInput, 7);
}

export function readIntegratedStartupSkillCatalogV8(revisionInput: unknown[]): SkillCatalog {
  return readReleasedCatalog(revisionInput, 8);
}

export function readIntegratedStartupSkillCatalogV9(revisionInput: unknown[]): SkillCatalog {
  return readReleasedCatalog(revisionInput, 9);
}

export function readIntegratedStartupSkillCatalog(revisionInput: unknown[]): SkillCatalog {
  return readReleasedCatalog(revisionInput, INTEGRATED_STARTUP_CATALOG_REVISION);
}

export function inspectIntegratedStartupSkillCatalog(
  catalog: SkillCatalog,
  revisionInput: unknown[],
): SkillCatalogReleaseReport {
  const refs = validateIntegratedDefinitions(catalog, revisionInput),
    available = catalog.nodes.filter(({ lifecycle }) => lifecycle === 'available'),
    report = inspectSkillCatalogRelease(catalog, {
      definitionRefs: refs,
      fixtureIds: available.flatMap(({ fixtureIds }) => fixtureIds),
    });
  if (
    report.available !== 34 ||
    report.verified !== 34 ||
    report.lifecycle.implemented !== 2 ||
    report.lifecycle.draft !== 1_116 ||
    report.issues.length
  )
    throw new Error('Integrated startup skill catalog release evidence is incomplete');
  return report;
}
