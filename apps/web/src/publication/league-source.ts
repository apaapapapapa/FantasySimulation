import {
  PublicLeagueDetailSchema,
  PublicLeagueSlotPageSchema,
  PublicLeagueSnapshotSchema,
  LeagueRevisionSchema,
  assertLeagueMetadata,
  canonicalJson,
  contentHash,
  type PublicCatalog,
  type PublicLeagueSnapshot,
  type PublicLeagueDetail,
  type PublicLeagueSlotPage,
  type PublicMatchRow,
} from '@fantasy/domain/spatial';
import { ReplayLoadError } from '../replay/artifacts.ts';
import type { PublicLibrary } from '../replay/public-source.ts';

const damaged = () => new ReplayLoadError('damaged', 'League reference identity mismatch');
export async function leagueSnapshot(
  library: PublicLibrary,
  hash: string,
  signal?: AbortSignal,
  ref?: NonNullable<PublicCatalog['leagues']>[number],
) {
  const snapshot = await library.leagueDocument({ hash }, PublicLeagueSnapshotSchema, signal);
  const revision = await library.leagueDocument(snapshot.definition, LeagueRevisionSchema, signal);
  await assertLeagueMetadata(snapshot, revision, ref).catch(() => {
    throw damaged();
  });
  if (
    snapshot.standings.rows.length !== snapshot.characters.length ||
    new Set(snapshot.characters.map((c) => c.id)).size !== snapshot.characters.length ||
    new Set(snapshot.standings.rows.map((r) => r.character)).size !== snapshot.characters.length ||
    new Set(snapshot.battlefields.map((f) => f.scenario.id)).size !==
      snapshot.battlefields.length ||
    snapshot.standings.rows.some((r) => !snapshot.characters.some((c) => c.id === r.character))
  )
    throw damaged();
  return snapshot;
}
export async function leagueDetail(
  library: PublicLibrary,
  snapshot: PublicLeagueSnapshot,
  character: string,
  signal?: AbortSignal,
) {
  const summary = snapshot.standings.rows.find((r) => r.character === character);
  if (!summary) throw damaged();
  const detail = await library.leagueDocument(summary.detail, PublicLeagueDetailSchema, signal);
  const { detail: _, ...standing } = summary;
  const { scenarios: __, opponents: ___, ...actual } = detail.standing;
  const opponents = snapshot.characters
    .filter((c) => c.id !== character)
    .map((c) => c.id)
    .sort();
  const scenarios = snapshot.battlefields
    .filter((f) => BigInt(f.weight.numerator) > 0n)
    .map((f) => f.scenario.id)
    .sort();
  if (
    detail.leagueHash !== snapshot.leagueHash ||
    canonicalJson(actual) !== canonicalJson(standing) ||
    canonicalJson(detail.standing.scenarios.map((s) => s.scenario).sort()) !==
      canonicalJson(scenarios) ||
    canonicalJson(detail.standing.opponents.map((o) => o.character).sort()) !==
      canonicalJson(opponents) ||
    canonicalJson(detail.opponents.map((o) => o.character).sort()) !== canonicalJson(opponents)
  )
    throw damaged();
  return detail;
}
export async function leaguePair(
  library: PublicLibrary,
  snapshot: PublicLeagueSnapshot,
  detail: PublicLeagueDetail,
  opponent: string,
  index: number,
  signal?: AbortSignal,
) {
  const ref = detail.opponents.find((o) => o.character === opponent)?.pages[index];
  if (!ref || opponent === detail.standing.character) throw damaged();
  const page = await library.leagueDocument(ref, PublicLeagueSlotPageSchema, signal);
  const characters = [detail.standing.character, opponent].sort();
  if (
    page.leagueHash !== snapshot.leagueHash ||
    page.index !== index ||
    page.rows.length !== ref.rows ||
    canonicalJson(page.characters) !== canonicalJson(characters)
  )
    throw damaged();
  let last = '';
  for (const { slot } of page.rows) {
    if (
      slot.id <= last ||
      canonicalJson(slot.characters.map((character) => character.id)) !== canonicalJson(characters)
    )
      throw damaged();
    last = slot.id;
  }
  return page;
}

/** Join a <=100-slot page to its pinned set rows; recordings stay unloaded until selection. */
export async function leaguePairMatches(
  library: PublicLibrary,
  catalog: PublicCatalog,
  snapshot: PublicLeagueSnapshot,
  pair: PublicLeagueSlotPage,
  signal?: AbortSignal,
) {
  const sets = new Map<string, Awaited<ReturnType<PublicLibrary['set']>>>();
  const pages = new Map<string, Awaited<ReturnType<PublicLibrary['page']>>>();
  const result: { planned: PublicLeagueSlotPage['rows'][number]; row: PublicMatchRow }[] = [];
  for (const planned of pair.rows) {
    const ref = catalog.sets.find((r) => r.setHash === planned.setHash);
    if (!ref) throw damaged();
    let set = sets.get(ref.setHash);
    if (!set) {
      set = await library.set(ref, signal);
      sets.set(ref.setHash, set);
    }
    const key = `${ref.setHash}/${planned.pageHash}`;
    let page = pages.get(key);
    if (!page) {
      const index = set.pages.findIndex((p) => p.pageHash === planned.pageHash);
      page = await library.page(ref.setHash, set, index, signal);
      pages.set(key, page);
    }
    const row = page.rows.find((r) => r.slotId === planned.rowId);
    if (
      !row ||
      (planned.cancelled && row.state !== 'failed') ||
      set.source.sha !== snapshot.sourceSha ||
      set.engineVersion !== snapshot.engineVersion ||
      set.implementationDigest !== snapshot.implementationDigest ||
      row.simulationHash !== planned.slot.simulationHash ||
      row.seed !== planned.slot.seed ||
      row.scenario.id !== planned.slot.scenario.id ||
      row.slotId !==
        (await contentHash({
          key: planned.slot.id.slice(7),
          simulationHash: planned.slot.simulationHash,
        })) ||
      canonicalJson(row.participants.map((p) => p.character.id).sort()) !==
        canonicalJson(pair.characters)
    )
      throw damaged();
    result.push({ planned, row });
  }
  return result;
}
