import { catalogManifest } from '@fantasy/samples';
import { prepareBattle, runPreparedBattle } from '@fantasy/engine/spatial';
import { ReplayWriter } from '@fantasy/api/testing';

// New fixed display input for #82: #61 stamina, walk/run, staged dash/sweep and forced motion.
// It is not an engine oracle; regeneration needs review like the other saved fixtures.
const input = await catalogManifest(
  'stage-vanguard-v1',
  'staged-duelist-v1',
  'flat-surveyed-v1',
  300,
  42,
);
const battle = await prepareBattle(input),
  output = await runPreparedBattle(battle);
const actors = output.records.flatMap((r) =>
  r.kind === 'interval' || r.kind === 'boundary' ? r.changes : [],
);
const required = {
  run: actors.some((a) => a.locomotion?.mode === 'run'),
  walk: actors.some((a) => a.locomotion?.mode === 'walk'),
  stamina: actors.some((a) => a.resources?.stamina !== undefined),
  secondStage: actors.some((a) => (a.action?.stage?.contact.stageIndex ?? 0) > 0),
  dash: actors.some((a) => a.action?.stage?.motion?.kind === 'dash'),
  force: actors.some((a) => a.force?.active),
};
if (Object.values(required).includes(false))
  throw new Error(`Missing #61 display elements: ${JSON.stringify(required)}`);
const writer = await ReplayWriter.create(process.argv[2] ?? '.generated/replay-82-stages', {
  id: 'stage-vanguard-staged-duelist-300',
  attemptId: 'stages-attempt',
  simulationHash: battle.simulationHash,
  input: battle.manifest,
});
for (const record of output.records) await writer.append(record);
await writer.finish({ kind: 'result', result: output.result }, 'stages-result');
