import { parseJson } from '@fantasy/domain/spatial';
import { z } from 'zod';
import { StoreError } from '../db/store-error.ts';

export function body<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  try {
    return parseJson(schema, input);
  } catch (error) {
    throw new StoreError(
      'invalid-input',
      (error instanceof Error ? error.message : 'Invalid JSON').slice(0, 1000),
    );
  }
}
