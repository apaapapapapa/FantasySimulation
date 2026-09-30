import {
  JobResponseSchema,
  SkillCatalogSchema,
  SkillConfigurationSchema,
  SkillLoadoutRevisionSchema,
  type SkillCatalog,
  type SkillConfiguration,
  type SkillLoadoutRevision,
} from '@fantasy/domain';
import type { Revision } from '@fantasy/domain/spatial';
import { api } from '../api-client.ts';
import { loadRevisionCatalog } from './revision-catalog.ts';

export type SkillRevisionRef = Pick<SkillLoadoutRevision, 'id' | 'revision' | 'contentHash'>;
export type SkillCharacter = Extract<Revision, { kind: 'character' }>;
export type SkillLoadoutHead = {
  schemaVersion: 1;
  id: string;
  version: number;
  latest: SkillRevisionRef;
  snapshot: SkillLoadoutRevision;
  createdAt: string;
  updatedAt: string;
};
export type SkillBattleRequest = {
  job: unknown;
  actorId: string;
  skillLoadout: SkillRevisionRef;
};

export interface SkillWorkbenchClient {
  getCatalog(id: string, version: number, signal?: AbortSignal): Promise<SkillCatalog>;
  listCharacters(signal?: AbortSignal): Promise<SkillCharacter[]>;
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
    if (!value || typeof value !== 'object' || !('catalog' in value))
      throw new Error('Invalid skill catalog record');
    return SkillCatalogSchema.parse(value.catalog);
  },
};
const loadoutHead = {
  parse(value: unknown): SkillLoadoutHead {
    if (!value || typeof value !== 'object') throw new Error('Invalid skill loadout head');
    const source = value as Record<string, unknown>;
    const snapshot = SkillLoadoutRevisionSchema.parse(source.snapshot);
    if (
      source.schemaVersion !== 1 ||
      typeof source.id !== 'string' ||
      !Number.isInteger(source.version) ||
      typeof source.createdAt !== 'string' ||
      typeof source.updatedAt !== 'string'
    )
      throw new Error('Invalid skill loadout head');
    const latest = source.latest as Record<string, unknown> | undefined;
    if (
      !latest ||
      typeof latest.id !== 'string' ||
      !Number.isInteger(latest.revision) ||
      typeof latest.contentHash !== 'string'
    )
      throw new Error('Invalid skill loadout reference');
    return {
      schemaVersion: 1,
      id: source.id,
      version: source.version as number,
      latest: latest as SkillRevisionRef,
      snapshot,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  },
};
const loadoutPage = {
  parse(value: unknown) {
    if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items))
      throw new Error('Invalid skill loadout page');
    if (
      !('nextCursor' in value) ||
      (value.nextCursor !== null && typeof value.nextCursor !== 'string')
    )
      throw new Error('Invalid skill loadout cursor');
    return {
      items: value.items.map((item) => loadoutHead.parse(item)),
      nextCursor: value.nextCursor,
    };
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
  listLoadouts: async (signal) => {
    const items: SkillLoadoutHead[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { items: SkillLoadoutHead[]; nextCursor: string | null } = await api(
        `skill-loadouts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        loadoutPage,
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
    api('skill-loadouts', loadoutHead, {
      method: 'POST',
      body: { character, configuration: SkillConfigurationSchema.parse(configuration) },
    }),
  updateLoadout: (id, expectedRevision, character, configuration) =>
    api(`skill-loadouts/${encodeURIComponent(id)}`, loadoutHead, {
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
