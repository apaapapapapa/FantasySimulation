import { expect, it } from 'vite-plus/test';
import { ZodError } from 'zod';
import { ReplayValidationError, RevisionGraphError } from '@fantasy/domain/spatial';
import { artifactOperationCode, OperationError } from './operation-error.ts';
import { operationCode } from './operation-code.ts';

it.each([
  ['budget', () => new OperationError('BUDGET_EXCEEDED', 'limit'), 'BUDGET_EXCEEDED'],
  ['replay', () => new ReplayValidationError('bad checkpoint'), 'DATA_INVALID'],
  ['schema', () => new ZodError([]), 'INPUT_INVALID'],
  ['revision', () => new RevisionGraphError('missing-revision', 'missing'), 'INPUT_INVALID'],
  ['unknown', () => new Error('unknown failure'), 'UNKNOWN'],
  ['untrusted code', () => ({ code: 'BUDGET_EXCEEDED' }), 'UNKNOWN'],
] as const)(
  'preserves %s classification at saved-data and runtime boundaries',
  (_, create, expected) => {
    const error = create();
    expect(artifactOperationCode(error)).toBe(expected);
    expect(operationCode(error)).toBe(expected);
  },
);

it('keeps the caller-selected schema classification at both boundaries', () => {
  const error = new ZodError([]);
  expect(artifactOperationCode(error, 'DATA_INVALID')).toBe('DATA_INVALID');
  expect(operationCode(error, 'DATA_INVALID')).toBe('DATA_INVALID');
});
