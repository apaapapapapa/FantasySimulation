import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'drizzle-kit';

// All documented Kit commands run at the repository root. Existing environment
// variables take precedence over .env, just as they do for the API process.
if (existsSync('.env')) loadEnvFile('.env');
const filename = process.env.DATABASE_PATH ?? './data/fantasy.sqlite';
if (!filename.trim() || filename === ':memory:')
  throw new Error('Drizzle Kit requires a persistent DATABASE_PATH.');
const databasePath = resolve(filename);
mkdirSync(dirname(databasePath), { recursive: true });

export default defineConfig({
  dialect: 'sqlite',
  schema: resolve('apps/api/src/db/schema.ts'),
  out: resolve('db/drizzle'),
  dbCredentials: { url: databasePath },
});
