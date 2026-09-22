import { runBattle, catalogManifest } from '../packages/engine/src/spatial/index.ts';

const [left = 'swordsman', right = 'sky-mage', scenario = 'pillars'] = process.argv.slice(2);
const { result, records } = await runBattle(await catalogManifest(left, right, scenario));
console.log(JSON.stringify({ result, records: records.length }, null, 2));
