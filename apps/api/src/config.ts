import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// src/ and dist/ have the same depth below the repository root.
export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function readConfig() {
  const env = z
    .object({
      API_HOST: z.string().min(1).default('127.0.0.1'),
      API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
      DATABASE_PATH: z.string().min(1).default('./data/fantasy.sqlite'),
      ARTIFACT_PATH: z.string().min(1).default('./data/replays'),
      BATTLE_WORKERS: z.coerce.number().int().min(1).max(4).default(1),
      BATTLE_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(30000),
      BATTLE_QUEUE_LIMIT: z.coerce.number().int().min(1).max(128).default(128),
      BATTLE_STORAGE_BYTES: z.coerce
        .number()
        .int()
        .min(41943040)
        .max(16 * 1024 ** 3)
        .default(16 * 1024 ** 3),
      BATTLE_RSS_BYTES: z.coerce
        .number()
        .int()
        .min(1)
        .max(1.5 * 1024 ** 3)
        .default(1.5 * 1024 ** 3),
    })
    .parse(process.env);
  return {
    host: env.API_HOST,
    port: env.API_PORT,
    databasePath: resolve(repositoryRoot, env.DATABASE_PATH),
    artifactPath: resolve(repositoryRoot, env.ARTIFACT_PATH),
    runtime: {
      workers: env.BATTLE_WORKERS,
      timeoutMs: env.BATTLE_TIMEOUT_MS,
      queueLimit: env.BATTLE_QUEUE_LIMIT,
      storageBytes: env.BATTLE_STORAGE_BYTES,
      maxRssBytes: env.BATTLE_RSS_BYTES,
    },
  };
}
