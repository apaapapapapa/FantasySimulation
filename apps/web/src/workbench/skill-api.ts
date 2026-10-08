import {
  AnySkillLoadoutCreateSchema,
  AnySkillLoadoutHeadSchema,
  AnySkillLoadoutPageSchema,
  AnySkillLoadoutPatchSchema,
  DEFAULT_SKILL_CATALOG_REFERENCE,
  JobResponseSchema,
  canonicalJson,
  SkillPreviewRequestSchema,
  SkillPreviewResponseSchema,
  type SkillPreviewRequest,
  type SkillPreviewResponse,
  SkillAcquisitionHeadSchema,
  SkillCatalogRecordSchema,
  type AnySkillConfiguration,
  type AnySkillLoadoutHead,
  type SkillAcquisitionHead,
  type SkillAcquisitionSelection,
  type SkillCatalog,
} from '@fantasy/domain';
import type { Revision } from '@fantasy/domain/spatial';
import { api } from '../api-client.ts';
import { loadRevisionCatalog, loadRevisionKind } from './revision-catalog.ts';

export type SkillRevisionRef = AnySkillLoadoutHead['latest'];
export type SkillCharacter = Extract<Revision, { kind: 'character' }>;
export type SkillAbility = Extract<Revision, { kind: 'ability' }>;
export type { AnySkillLoadoutHead as SkillLoadoutHead, SkillAcquisitionHead };
export type SkillLoadoutSelection = {
  loadout: SkillRevisionRef;
  character: SkillRevisionRef;
};
export const DEFAULT_SKILL_CATALOG = {
  id: DEFAULT_SKILL_CATALOG_REFERENCE.id,
  revision: DEFAULT_SKILL_CATALOG_REFERENCE.revision,
} as const;
export const sameSkillRevisionRef = (left: SkillRevisionRef, right: SkillRevisionRef) =>
  left.id === right.id &&
  left.revision === right.revision &&
  left.contentHash === right.contentHash;
export const skillLoadoutsForCatalog = (
  loadouts: AnySkillLoadoutHead[],
  catalog: SkillRevisionRef,
) => loadouts.filter((item) => sameSkillRevisionRef(item.snapshot.configuration.catalog, catalog));
export const sameSkillNodeIds = (left: readonly string[], right: readonly string[]) =>
  [...left].sort().join('\n') === [...right].sort().join('\n');
/** A saved schema-v2 loadout stays selectable, but not editable, once its acquisition advanced. */
export const skillAcquisitionAdvanced = (
  loadout: AnySkillLoadoutHead,
  acquisition: SkillAcquisitionHead | null,
) =>
  loadout.snapshot.configuration.schemaVersion === 2 &&
  acquisition !== null &&
  !sameSkillRevisionRef(loadout.snapshot.configuration.acquisition, acquisition.latest);
export type SkillBattleRequest = {
  job: unknown;
  actorId: string;
  skillLoadout: SkillRevisionRef;
};

export interface SkillWorkbenchClient {
  preview(input: SkillPreviewRequest, signal?: AbortSignal): Promise<SkillPreviewResponse>;
  getCatalog(id: string, version: number, signal?: AbortSignal): Promise<SkillCatalog>;
  listCharacters(signal?: AbortSignal): Promise<SkillCharacter[]>;
  listAbilities(signal?: AbortSignal): Promise<SkillAbility[]>;
  listLoadouts(signal?: AbortSignal): Promise<AnySkillLoadoutHead[]>;
  getAcquisition(id: string, signal?: AbortSignal): Promise<SkillAcquisitionHead>;
  createAcquisition(selection: SkillAcquisitionSelection): Promise<SkillAcquisitionHead>;
  updateAcquisition(
    id: string,
    expectedVersion: number,
    selection: SkillAcquisitionSelection,
  ): Promise<SkillAcquisitionHead>;
  createLoadout(
    character: SkillRevisionRef,
    configuration: AnySkillConfiguration,
  ): Promise<AnySkillLoadoutHead>;
  updateLoadout(
    id: string,
    expectedRevision: number,
    character: SkillRevisionRef,
    configuration: AnySkillConfiguration,
  ): Promise<AnySkillLoadoutHead>;
  createBattleJob(input: SkillBattleRequest): Promise<ReturnType<typeof JobResponseSchema.parse>>;
}

export async function createOrRecoverSkillAcquisition(
  client: Pick<SkillWorkbenchClient, 'createAcquisition' | 'getAcquisition'>,
  selection: SkillAcquisitionSelection,
) {
  try {
    return await client.createAcquisition(selection);
  } catch (cause) {
    let existing: SkillAcquisitionHead;
    try {
      existing = await client.getAcquisition(selection.id);
    } catch {
      throw cause;
    }
    if (
      existing.version === 1 &&
      sameSkillRevisionRef(existing.snapshot.character, selection.character) &&
      sameSkillRevisionRef(existing.snapshot.catalog, selection.catalog) &&
      sameSkillNodeIds(existing.snapshot.learnedNodeIds, selection.learnedNodeIds)
    )
      return existing;
    throw cause;
  }
}

const catalogRecord = {
  parse(value: unknown) {
    return SkillCatalogRecordSchema.parse(value).catalog;
  },
};

/** The only place that knows the provisional SK-02 HTTP envelopes. */
export const skillWorkbenchApi: SkillWorkbenchClient = {
  preview: (input, signal) =>
    api('skill-preview', SkillPreviewResponseSchema, {
      method: 'POST',
      body: SkillPreviewRequestSchema.parse(input),
      ...(signal ? { signal } : {}),
    }),
  getCatalog: (id, version, signal) =>
    api(`skill-catalogs/${encodeURIComponent(id)}/${version}`, catalogRecord, {
      ...(signal ? { signal } : {}),
      maxBytes: 8 * 1024 * 1024,
    }),
  listCharacters: async (signal) => {
    const [characters] = await loadRevisionCatalog(signal ?? new AbortController().signal);
    return characters.filter((item): item is SkillCharacter => item.kind === 'character');
  },
  listAbilities: async (signal) => {
    const abilities = await loadRevisionKind('ability', signal ?? new AbortController().signal);
    return abilities.filter((item): item is SkillAbility => item.kind === 'ability');
  },
  listLoadouts: async (signal) => {
    const items: AnySkillLoadoutHead[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { items: AnySkillLoadoutHead[]; nextCursor: string | null } = await api(
        `skill-loadouts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        AnySkillLoadoutPageSchema,
        { ...(signal ? { signal } : {}), maxBytes: 8 * 1024 * 1024 },
      );
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Skill loadout cursor repeated');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return items;
  },
  getAcquisition: (id, signal) =>
    api(`skill-acquisitions/${encodeURIComponent(id)}`, SkillAcquisitionHeadSchema, {
      ...(signal ? { signal } : {}),
    }),
  createAcquisition: (selection) =>
    api('skill-acquisitions', SkillAcquisitionHeadSchema, {
      method: 'POST',
      body: { selection },
    }),
  updateAcquisition: (id, expectedVersion, selection) =>
    api(`skill-acquisitions/${encodeURIComponent(id)}`, SkillAcquisitionHeadSchema, {
      method: 'PATCH',
      body: { expectedVersion, selection },
    }),
  createLoadout: (character, configuration) =>
    api('skill-loadouts', AnySkillLoadoutHeadSchema, {
      method: 'POST',
      body: AnySkillLoadoutCreateSchema.parse({ character, configuration }),
    }),
  updateLoadout: (id, expectedRevision, character, configuration) =>
    api(`skill-loadouts/${encodeURIComponent(id)}`, AnySkillLoadoutHeadSchema, {
      method: 'PATCH',
      body: AnySkillLoadoutPatchSchema.parse({
        expectedVersion: expectedRevision,
        character,
        configuration,
      }),
    }),
  createBattleJob: (input) =>
    api('skill-battle-jobs', JobResponseSchema, {
      method: 'POST',
      body: {
        ...(input.job as object),
        loadouts: [{ actorId: input.actorId, loadout: input.skillLoadout }],
      },
      headers: { 'x-client-id': 'local-web', 'idempotency-key': crypto.randomUUID() },
    }),
};

/** Collection-valued proposal identity; exact character/catalog references are preserved. */
export function skillPreviewKey(input: SkillPreviewRequest) {
  return canonicalJson({
    ...input,
    learnedNodeIds: [...input.learnedNodeIds].sort(),
    enabledNodeIds: [...input.enabledNodeIds].sort(),
  });
}
export async function currentSkillPreview(
  client: Pick<SkillWorkbenchClient, 'preview'>,
  input: SkillPreviewRequest,
  attempt: { isCurrent(): boolean },
  signal: AbortSignal,
) {
  const result = await client.preview(input, signal);
  if (signal.aborted || !attempt.isCurrent()) return null;
  if (skillPreviewKey(result.proposal) !== skillPreviewKey(input))
    throw new Error('Preview proposal identity mismatch');
  return result;
}
