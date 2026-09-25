import {
  PublicLeagueSnapshotSchema,
  PublicLeagueDetailSchema,
  PublicLeagueSlotPageSchema,
  LeagueRevisionSchema,
  LeagueProgressPageSchema,
  LeagueReservationSchema,
  PublicLeagueWorkSchema,
  type RevisionRef,
  canonicalJson,
  contentHash,
  revisionHash,
  type LeagueFileRef,
  type PublicCatalog,
  type PublicReplaySet,
  type PublicMatchPage,
  type BundleReceipt,
  type LeagueCell,
} from '@fantasy/domain/spatial';
import { leagueCoordinates, scoreLeagueCounts } from '@fantasy/engine/spatial';

export type LeagueJson = <T>(
  ref: LeagueFileRef,
  schema: { parse(value: unknown): T },
) => Promise<T>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const reference = ({ id, revision, contentHash }: RevisionRef) => ({ id, revision, contentHash });

/** Validate saved schedules and recompute their scores without executing a battle or opening a DB. */
export async function validatePublicLeague(
  ref: NonNullable<PublicCatalog['leagues']>[number],
  json: LeagueJson,
  sets: Map<string, PublicReplaySet>,
  pages: Map<string, PublicMatchPage>,
) {
  const snapshot = await json(ref, PublicLeagueSnapshotSchema);
  const revision = await json(snapshot.definition, LeagueRevisionSchema);
  const { leagueHash, ...body } = revision,
    { definition, engineVersion, implementationDigest } = revision;
  if (
    leagueHash !== (await contentHash(body)) ||
    revision.inputHash !==
      (await contentHash({ definition, engineVersion, implementationDigest })) ||
    ref.id !== definition.id ||
    ref.leagueHash !== leagueHash ||
    ref.inputHash !== revision.inputHash ||
    snapshot.leagueHash !== leagueHash ||
    snapshot.inputHash !== revision.inputHash ||
    snapshot.sourceSha !== revision.sourceSha ||
    snapshot.engineVersion !== engineVersion ||
    snapshot.implementationDigest !== implementationDigest ||
    snapshot.id !== definition.id ||
    snapshot.name !== definition.name ||
    snapshot.trials !== definition.trials ||
    snapshot.masterSeed !== definition.masterSeed
  )
    throw new Error('League snapshot definition identity mismatch');
  for (const revision of definition.revisions)
    if (revision.contentHash !== (await revisionHash(revision)))
      throw new Error('League definition revision checksum');
  const named = (kind: 'character' | 'scenario', id: string) => {
    const value = definition.revisions.find((r) => r.kind === kind && r.id === id);
    if (!value) throw new Error('League named revision missing');
    return {
      id,
      revision: value.revision,
      contentHash: value.contentHash,
      name: value.definition.name,
    };
  };
  if (
    !same(
      snapshot.characters,
      definition.characters.map((c) => named('character', c.id)),
    ) ||
    !same(
      snapshot.battlefields,
      definition.battlefields.map((f) => ({
        scenario: named('scenario', f.scenario.id),
        weight: f.weight,
      })),
    )
  )
    throw new Error('League display metadata mismatch');
  const expected = new Map<
    string,
    Awaited<ReturnType<ReturnType<typeof leagueCoordinates>['next']>>['value']
  >();
  for await (const entry of leagueCoordinates(definition)) expected.set(entry.slot.id, entry);
  const cells = new Map<string, LeagueCell>();
  const pairPages = new Map<string, string>();
  const visited = new Set<string>();
  const details = [];
  for (const summary of snapshot.standings.rows) {
    const detail = await json(summary.detail, PublicLeagueDetailSchema);
    if (
      detail.leagueHash !== leagueHash ||
      detail.standing.character !== summary.character ||
      detail.opponents.length !== definition.characters.length - 1
    )
      throw new Error('League detail identity mismatch');
    const opponents = new Set<string>();
    for (const opponent of detail.opponents) {
      if (
        opponents.has(opponent.character) ||
        opponent.character === summary.character ||
        !definition.characters.some((c) => c.id === opponent.character)
      )
        throw new Error('League opponent mismatch');
      opponents.add(opponent.character);
      const characters = [summary.character, opponent.character].sort();
      const pair = characters.join('/'),
        declaration = canonicalJson(opponent.pages);
      if (pairPages.has(pair)) {
        if (pairPages.get(pair) !== declaration) throw new Error('Inconsistent league pair pages');
        continue;
      }
      pairPages.set(pair, declaration);
      let last = '';
      for (const [index, pageRef] of opponent.pages.entries()) {
        const page = await json(pageRef, PublicLeagueSlotPageSchema);
        if (
          page.leagueHash !== leagueHash ||
          page.index !== index ||
          page.rows.length !== pageRef.rows ||
          !same(page.characters, characters)
        )
          throw new Error('League slot page identity mismatch');
        for (const row of page.rows) {
          const planned = expected.get(row.slot.id),
            { simulationHash, ...coordinate } = row.slot;
          if (
            !planned ||
            !same(planned.slot, coordinate) ||
            row.slot.id <= last ||
            visited.has(row.slot.id) ||
            !same(
              row.slot.characters.map((c) => c.id),
              characters,
            )
          )
            throw new Error('League planned slot mismatch');
          last = row.slot.id;
          visited.add(row.slot.id);
          const set = sets.get(row.setHash),
            matchPage = pages.get(`${row.setHash}/${row.pageHash}`);
          const match = matchPage?.rows.find((r) => r.slotId === row.rowId);
          if (
            !set ||
            !match ||
            set.source.sha !== revision.sourceSha ||
            set.engineVersion !== engineVersion ||
            set.implementationDigest !== implementationDigest ||
            match.simulationHash !== simulationHash ||
            row.rowId !== (await contentHash({ key: row.slot.id.slice(7), simulationHash })) ||
            !same(planned.spec, {
              seed: match.seed,
              participants: match.participants.map((p) => ({
                ...p,
                character: reference(p.character),
              })),
              ruleset: match.ruleset,
              scenario: reference(match.scenario),
            })
          )
            throw new Error('League slot and public replay binding mismatch');
          const key = `${pair}/${row.slot.scenario.id}`;
          const cell = cells.get(key) ?? {
            characters: row.slot.characters.map((c) => c.id) as [string, string],
            scenario: row.slot.scenario.id,
            planned: 0,
            wins: [0, 0],
            draws: 0,
          };
          cell.planned++;
          if (match.result?.outcome.kind === 'draw') cell.draws++;
          else if (match.result?.outcome.kind === 'win') {
            const winner = match.result.outcome.winner;
            const character = match.participants.find((p) => p.actorId === winner)!.character.id;
            cell.wins[character === characters[0] ? 0 : 1]++;
          }
          cells.set(key, cell);
        }
      }
    }
    details.push(detail.standing);
  }
  if (visited.size !== expected.size) throw new Error('League publication omits planned slots');
  const scores = scoreLeagueCounts({
    characters: definition.characters.map((c) => c.id),
    battlefields: definition.battlefields.map((f) => ({
      scenario: f.scenario.id,
      weight: f.weight,
    })),
    cells: [...cells.values()],
  });
  if (
    !same(scores, { ...snapshot.standings, rows: details }) ||
    !same(
      snapshot.standings.rows.map(({ detail: _, ...row }) => row),
      scores.rows.map(({ scenarios: _, opponents: __, ...row }) => row),
    )
  )
    throw new Error('League published score mismatch');
  return snapshot;
}

export async function validatePublicLeagueWork(
  ref: LeagueFileRef,
  json: LeagueJson,
  receipts: Map<string, BundleReceipt>,
) {
  const work = await json(ref, PublicLeagueWorkSchema);
  const records = new Map<
    string,
    ReturnType<typeof LeagueProgressPageSchema.parse>['records'][number]
  >();
  for (const pageRef of work.progress) {
    const page = await json(pageRef, LeagueProgressPageSchema),
      { id, ...body } = page;
    if (id !== (await contentHash(body)) || page.records.length !== pageRef.records)
      throw new Error('League progress page mismatch');
    for (const record of page.records) {
      if (records.has(record.simulationHash)) throw new Error('Duplicate retained league progress');
      records.set(record.simulationHash, record);
      for (const attempt of record.attempts)
        if (attempt.objectHash) {
          const receipt = receipts.get(attempt.objectHash);
          if (
            !receipt ||
            receipt.simulationHash !== record.simulationHash ||
            receipt.result.outcome.kind !== attempt.state
          )
            throw new Error('Retained league attempt has no verified receipt');
        }
    }
  }
  const partitions = new Set<string>();
  for (const reservationRef of work.reservations) {
    const reservation = await json(reservationRef, LeagueReservationSchema),
      { id, ...body } = reservation;
    const { id: progressId, ...progressBody } = reservation.progress;
    if (
      id !== (await contentHash(body)) ||
      progressId !== (await contentHash(progressBody)) ||
      reservation.partitionId !== reservationRef.partitionId ||
      partitions.has(reservation.partitionId) ||
      reservation.planId !== work.planId ||
      reservation.executionId !== work.executionId
    )
      throw new Error('Retained league reservation mismatch');
    partitions.add(reservation.partitionId);
    for (const record of reservation.progress.records) {
      const retained = records.get(record.simulationHash);
      if (!retained || (!work.previousWork && !same(retained, record)))
        throw new Error('Journal omits its reserved attempts');
    }
  }
  return { work, records };
}

type WorkState = Awaited<ReturnType<typeof validatePublicLeagueWork>>;
export function assertLeagueWorkTransition(previous: WorkState, current: WorkState) {
  const sameExecution = previous.work.executionId === current.work.executionId;
  if (
    sameExecution &&
    (!same(previous.work.reservations, current.work.reservations) ||
      previous.work.planId !== current.work.planId ||
      previous.work.inputHash !== current.work.inputHash ||
      previous.work.sourceSha !== current.work.sourceSha)
  )
    throw new Error('League execution journal identity changed');
  for (const [hash, prior] of previous.records) {
    const next = current.records.get(hash);
    if (!next) throw new Error('League journal drops retained attempt history');
    if (same(prior, next)) continue;
    const last = prior.attempts.at(-1);
    if (
      sameExecution &&
      last?.state === 'reserved' &&
      last.executionId === current.work.executionId
    ) {
      const prefix = prior.attempts.slice(0, -1),
        after = next.attempts.at(-1);
      if (
        same(next.attempts, prefix) ||
        (next.attempts.length === prior.attempts.length &&
          same(next.attempts.slice(0, -1), prefix) &&
          after?.attempt === last.attempt &&
          after.executionId === last.executionId &&
          after.state !== 'reserved')
      )
        continue;
    } else if (
      !sameExecution &&
      prior.attempts.length < 2 &&
      last?.state !== 'win' &&
      last?.state !== 'draw'
    ) {
      const after = next.attempts.at(-1);
      if (
        next.attempts.length === prior.attempts.length + 1 &&
        same(next.attempts.slice(0, -1), prior.attempts) &&
        after?.state === 'reserved' &&
        after.executionId === current.work.executionId
      )
        continue;
    }
    throw new Error('League journal rewrites consumed attempts');
  }
  for (const [hash, record] of current.records)
    if (
      !previous.records.has(hash) &&
      (sameExecution ||
        record.attempts.length !== 1 ||
        record.attempts[0]!.state !== 'reserved' ||
        record.attempts[0]!.executionId !== current.work.executionId)
    )
      throw new Error('New league attempt lacks durable admission');
}
