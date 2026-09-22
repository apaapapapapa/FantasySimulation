import { requireCondition, text } from './common.ts';

export function parseExceptionTime(value: unknown): number {
  const timestamp = text(value);
  // UTC ISO date-time, with seconds and optional three-digit milliseconds.
  requireCondition(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp),
    'INVALID_EXCEPTION_DATE',
  );
  const instant = Date.parse(timestamp);
  requireCondition(Number.isFinite(instant), 'INVALID_EXCEPTION_DATE');
  const canonical = timestamp.includes('.') ? timestamp : timestamp.replace('Z', '.000Z');
  requireCondition(new Date(instant).toISOString() === canonical, 'INVALID_EXCEPTION_DATE');
  return instant;
}
