import type { PreparedBattle } from './state.ts';
import {
  eventHashLine,
  trajectoryHashLine,
  encodeNumericState,
  contentHash,
  DEFAULT_BUDGET,
  hashBytes,
  type BattleResult,
  type Budget,
  type StreamRecord,
} from '@fantasy/domain/spatial/execution';
import { initializePhysics } from './world/physics.ts';
import { prepareBattle } from './prepare.ts';
import { simulate, type SimulationEnd } from './simulate.ts';

export { eventHashLine, trajectoryHashLine } from '@fantasy/domain/spatial/execution';
export async function finalizeBattleResult(
  simulationHash: string,
  end: SimulationEnd,
  hashes: { eventHash: string; trajectoryHash: string },
): Promise<BattleResult> {
  return {
    schemaVersion: 1,
    simulationHash,
    ...hashes,
    tsStateHash: await contentHash(encodeNumericState(end.decisionState)),
    physicsStateHash: await hashBytes(end.physicsState),
    steps: end.steps,
    outcome: end.outcome,
    stats: end.stats,
  };
}
/** Bounded convenience collector for fixtures/CLI. Production workers consume simulate() with backpressure. */
export async function runPreparedBattle(
  battle: PreparedBattle,
  budget: Budget = DEFAULT_BUDGET,
): Promise<{ result: BattleResult; records: StreamRecord[] }> {
  await initializePhysics();
  const stream = simulate(battle, budget),
    records: StreamRecord[] = [];
  let next = stream.next();
  while (!next.done) {
    records.push(next.value);
    next = stream.next();
  }
  const end = next.value;
  const encoder = new TextEncoder();
  const eventHash = await hashBytes(
    encoder.encode(
      records
        .flatMap((r) => ('events' in r ? r.events : []))
        .map(eventHashLine)
        .join(''),
    ),
  );
  const trajectoryHash = await hashBytes(encoder.encode(records.map(trajectoryHashLine).join('')));
  return {
    records,
    result: await finalizeBattleResult(battle.simulationHash, end, { eventHash, trajectoryHash }),
  };
}
export async function runBattle(input: unknown, budget: Budget = DEFAULT_BUDGET) {
  return runPreparedBattle(await prepareBattle(input), budget);
}
