import { runBattle, sampleManifest } from '../packages/engine/src/spatial/index.ts';

const { result, records } = await runBattle(await sampleManifest());
console.log(JSON.stringify({ result, records: records.length }, null, 2));
