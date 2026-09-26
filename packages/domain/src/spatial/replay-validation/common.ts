import { canonicalJson } from '../canonical.ts';
/** A rejected saved recording, distinct from unexpected validator/programming failures. */
export class ReplayValidationError extends Error {}
export const fail = (message: string): never => {
  throw new ReplayValidationError(`Invalid replay: ${message}`);
};
export const requireReplay = (condition: boolean, message: string) => {
  if (!condition) fail(message);
};
export const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export const phases = {
  boundary: 0,
  declaration: 1,
  launch: 2,
  contact: 3,
  resolution: 4,
  terminal: 5,
};
export const emittedId = (id: string) => {
  if (!/^e\.(0|[1-9][0-9]{0,6})$/.test(id)) return fail('event ID');
  return Number(id.slice(2));
};
