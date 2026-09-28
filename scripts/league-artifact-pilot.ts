import { join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { canonicalJson } from '@fantasy/domain/spatial';
import { pipelineContext } from './league-pipeline-context.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import { uploadPipelineArtifact } from './league-pipeline-upload.ts';

const root = resolve('.generated/league-artifact-pilot');
await mkdir(root, { recursive: true });
const context = await pipelineContext(root);
const github = new PipelineArtifacts(context.token, context.identity, 200, 'league-pilot.yml');
const prefix = context.prefix,
  started = performance.now();
const payload = (index: number) =>
  canonicalJson({ identity: context.identity, index, bytes: 'quota-and-live-visibility-6.2.1' });
const action = process.argv[2];
if (action === 'produce') {
  for (let index = 0; index < 32; index++) {
    const path = join(root, 'payload.json');
    await writeFile(path, payload(index));
    await uploadPipelineArtifact(`${prefix}-pilot-${index}`, [path], root);
  }
  for (let poll = 0; poll < 110; poll++) {
    const ack = (await github.list()).find((a) => a.name === prefix + '-ack');
    if (ack) {
      await github.download(ack, join(root, 'ack'), (key) => key === 'visibility.json');
      const receipt = JSON.parse(await readFile(join(root, 'ack/visibility.json'), 'utf8'));
      if (
        receipt.verified !== 32 ||
        receipt.producerStatus !== 'in_progress' ||
        canonicalJson(receipt.identity) !== canonicalJson(context.identity)
      )
        throw new Error('Pilot visibility receipt mismatch');
      console.log(
        JSON.stringify({ quota: 32, consumerAck: ack, elapsedMs: performance.now() - started }),
      );
      process.exit(0);
    }
    await setTimeout(5000);
  }
  throw new Error('Live artifact visibility acknowledgement deadline');
} else if (action === 'consume') {
  const verified = new Map<number, unknown>();
  for (let poll = 0; poll < 110; poll++) {
    const all = await github.list();
    for (let index = 0; index < 32; index++) {
      if (verified.has(index)) continue;
      const ref = all.find((a) => a.name === `${prefix}-pilot-${index}`);
      if (!ref) continue;
      const download = join(root, 'part-' + index),
        at = performance.now();
      await github.download(ref, download, (key) => key === 'payload.json');
      if ((await readFile(join(download, 'payload.json'), 'utf8')) !== payload(index))
        throw new Error('Pilot exact ZIP payload mismatch');
      verified.set(index, { ref, visibleAtMs: at - started, downloadMs: performance.now() - at });
    }
    if (verified.size === 32) {
      const jobs = await github.request(
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
        {
          run_id: context.identity.runId,
          attempt_number: context.identity.runAttempt,
          per_page: 100,
        },
      );
      const producers = jobs.jobs.filter((job: { name: string }) => job.name === 'produce');
      if (
        jobs.jobs.length !== jobs.total_count ||
        producers.length !== 1 ||
        producers[0].status !== 'in_progress'
      )
        throw new Error('Artifacts were not observed while producer was active');
      const path = join(root, 'visibility.json');
      await writeFile(
        path,
        canonicalJson({
          identity: context.identity,
          verified: 32,
          producerStatus: 'in_progress',
          observations: [...verified.values()],
          metadata: github.metrics(),
        }),
      );
      await uploadPipelineArtifact(prefix + '-ack', [path], root);
      process.exit(0);
    }
    await setTimeout(5000);
  }
  throw new Error('Live artifact visibility download deadline');
} else throw new Error('Expected produce or consume');
