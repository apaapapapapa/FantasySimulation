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
    })
    .parse(process.env);
  return {
    host: env.API_HOST,
    port: env.API_PORT,
    databasePath: resolve(repositoryRoot, env.DATABASE_PATH),
  };
}
