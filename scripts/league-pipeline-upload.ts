import artifact from '@actions/artifact';
import { lstat } from 'node:fs/promises';
import { relative } from 'node:path';
import { measureAsync, currentMeasurements } from '@fantasy/api/tooling';
import { artifactDigest } from './league-artifact-policy.ts';
import type { PipelineArtifact } from './league-pipeline-artifacts.ts';

export async function uploadPipelineArtifact(
  name: string,
  files: string[],
  root: string,
): Promise<PipelineArtifact> {
  let bytes = 0;
  if (!/^league-[a-zA-Z0-9-]+$/.test(name) || files.length < 1 || files.length > 50000)
    throw new Error('Invalid pipeline upload');
  for (const path of files) {
    const key = relative(root, path),
      info = await lstat(path);
    if (!key || key.startsWith('..') || key.includes('\\') || !info.isFile())
      throw new Error('Unsafe pipeline upload');
    bytes += info.size;
  }
  if (bytes > 60 * 1024 ** 2) throw new Error('Pipeline input/archive raw-byte bound');
  const uploaded = await measureAsync('artifact.upload', () =>
    artifact.uploadArtifact(name, files, root, { retentionDays: 7, compressionLevel: 0 }),
  );
  currentMeasurements()?.addBytes('artifact.upload', bytes);
  if (!uploaded.id || !uploaded.size || uploaded.size > 64 * 1024 ** 2)
    throw new Error('Pipeline immutable archive bound');
  return { id: uploaded.id, name, digest: artifactDigest(uploaded.digest), bytes: uploaded.size };
}
