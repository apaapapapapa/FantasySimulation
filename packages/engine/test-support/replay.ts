import {
  ReplayState,
  replayContext,
  type Manifest,
  type BattleResult,
  type StreamRecord,
} from '@fantasy/domain/spatial';
import { prepareBattle } from '../src/spatial/prepare.ts';

/** Record every display checkpoint for scenario-specific seek assertions. No expected values. */
export async function recordedCheckpoints(
  input: Manifest,
  output: { result: BattleResult; records: StreamRecord[] },
) {
  const context = await replayContext(
    (await prepareBattle(input)).manifest,
    output.result.simulationHash,
  );
  const replay = new ReplayState(context),
    checkpoints = [];
  for (const record of output.records) {
    replay.apply(record);
    checkpoints.push(replay.checkpoint());
  }
  return { context, replay, checkpoints };
}
