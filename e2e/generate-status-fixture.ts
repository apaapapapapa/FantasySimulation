import { catalogManifest } from '@fantasy/samples';
import { prepareBattle, runPreparedBattle, sealRevision, reference } from '@fantasy/engine/spatial';
import { ReplayWriter } from '@fantasy/api/testing';

// New fixed input for display acceptance, never a replacement for an existing oracle.
const input = await catalogManifest('swordsman', 'sky-mage', 'pillars-surveyed-v1', 240, 42);
const status = input.revisions.find((r) => r.kind === 'status' && r.id === 'flight');
const ability = input.revisions.find((r) => r.kind === 'ability' && r.id === 'takeoff');
const character = input.revisions.find((r) => r.kind === 'character' && r.id === 'sky-mage');
if (status?.kind !== 'status' || ability?.kind !== 'ability' || character?.kind !== 'character')
  throw new Error('Missing fixed catalog definitions');
const flight = await sealRevision('status', status.id, 2, {
  ...status.definition,
  durationSteps: 5,
});
const takeoff = await sealRevision('ability', ability.id, 2, {
  ...ability.definition,
  effects: [{ kind: 'apply-status', status: reference(flight) }],
});
const mage = await sealRevision('character', character.id, 2, {
  ...character.definition,
  abilities: character.definition.abilities.map((a) =>
    a.id === takeoff.id ? reference(takeoff) : a,
  ),
});
input.revisions = input.revisions.map(
  (r) => [flight, takeoff, mage].find((next) => next.kind === r.kind && next.id === r.id) ?? r,
);
input.participants[1]!.character = reference(mage);
const battle = await prepareBattle(input),
  output = await runPreparedBattle(battle);
const events = output.records.flatMap((r) => ('events' in r ? r.events : []));
console.log(events.filter((e) => e.kind.includes('status')).map((e) => [e.step, e.kind, e.reason]));
if (
  !events.some((e) => e.step === 5 && e.kind === 'status-remove' && e.reason === 'flight:expired')
)
  throw new Error('Expected actual expiry at step 5');
const writer = await ReplayWriter.create(process.argv[2] ?? '.generated/replay-79-expiry', {
  id: 'status-expiry-240',
  attemptId: 'expiry-attempt',
  simulationHash: battle.simulationHash,
  input: battle.manifest,
});
for (const record of output.records) await writer.append(record);
await writer.finish({ kind: 'result', result: output.result }, 'expiry-result');
