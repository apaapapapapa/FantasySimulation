import {
  JobResponseSchema,
  SkillCatalogRecordSchema,
  SkillConfigurationSchema,
  SkillLoadoutHeadSchema,
  SkillLoadoutPageSchema,
  type SkillCatalog,
  type SkillConfiguration,
  type SkillLoadoutHead,
} from '@fantasy/domain';
import type { Revision } from '@fantasy/domain/spatial';
import { api } from '../api-client.ts';
import { loadRevisionCatalog, loadRevisionKind } from './revision-catalog.ts';

export type SkillRevisionRef = SkillLoadoutHead['latest'];
export type SkillCharacter = Extract<Revision, { kind: 'character' }>;
export type SkillAbility = Extract<Revision, { kind: 'ability' }>;
export type { SkillLoadoutHead };
export type SkillLoadoutSelection = {
  loadout: SkillRevisionRef;
  character: SkillRevisionRef;
};
export const DEFAULT_SKILL_CATALOG = { id: 'skill-catalog-v1', revision: 7 } as const;
export const sameSkillRevisionRef = (left: SkillRevisionRef, right: SkillRevisionRef) =>
  left.id === right.id &&
  left.revision === right.revision &&
  left.contentHash === right.contentHash;
export const skillLoadoutsForCatalog = (loadouts: SkillLoadoutHead[], catalog: SkillRevisionRef) =>
  loadouts.filter((item) => sameSkillRevisionRef(item.snapshot.configuration.catalog, catalog));
export type SkillBattleRequest = {
  job: unknown;
  actorId: string;
  skillLoadout: SkillRevisionRef;
};

export interface SkillWorkbenchClient {
  getCatalog(id: string, version: number, signal?: AbortSignal): Promise<SkillCatalog>;
  listCharacters(signal?: AbortSignal): Promise<SkillCharacter[]>;
  listAbilities(signal?: AbortSignal): Promise<SkillAbility[]>;
  listLoadouts(signal?: AbortSignal): Promise<SkillLoadoutHead[]>;
  createLoadout(
    character: SkillRevisionRef,
    configuration: SkillConfiguration,
  ): Promise<SkillLoadoutHead>;
  updateLoadout(
    id: string,
    expectedRevision: number,
    character: SkillRevisionRef,
    configuration: SkillConfiguration,
  ): Promise<SkillLoadoutHead>;
  createBattleJob(input: SkillBattleRequest): Promise<ReturnType<typeof JobResponseSchema.parse>>;
}

const catalogRecord = {
  parse(value: unknown) {
    return SkillCatalogRecordSchema.parse(value).catalog;
  },
};

/** The only place that knows the provisional SK-02 HTTP envelopes. */
export const skillWorkbenchApi: SkillWorkbenchClient = {
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
    const items: SkillLoadoutHead[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { items: SkillLoadoutHead[]; nextCursor: string | null } = await api(
        `skill-loadouts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        SkillLoadoutPageSchema,
        { ...(signal ? { signal } : {}), maxBytes: 8 * 1024 * 1024 },
      );
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Skill loadout cursor repeated');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return items;
  },
  createLoadout: (character, configuration) =>
    api('skill-loadouts', SkillLoadoutHeadSchema, {
      method: 'POST',
      body: { character, configuration: SkillConfigurationSchema.parse(configuration) },
    }),
  updateLoadout: (id, expectedRevision, character, configuration) =>
    api(`skill-loadouts/${encodeURIComponent(id)}`, SkillLoadoutHeadSchema, {
      method: 'PATCH',
      body: {
        expectedVersion: expectedRevision,
        character,
        configuration: SkillConfigurationSchema.parse(configuration),
      },
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
