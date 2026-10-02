import { parseJson } from '@fantasy/domain/spatial';
import { z } from 'zod';
import { invalidInput } from '../db/store-error.ts';

export function body<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  try {
    return parseJson(schema, input);
  } catch (error) {
    invalidInput(error, 'Invalid JSON');
  }
}
