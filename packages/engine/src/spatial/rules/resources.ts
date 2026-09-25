import type {
  DeepReadonly,
  Definition,
  ResourceState,
  ResourceLimits,
} from '@fantasy/domain/spatial/execution';
export {
  initialResources,
  resourceLimits,
  type ResourceLimits,
} from '@fantasy/domain/spatial/execution';

type Character = DeepReadonly<Definition<'character'>>;
export type ResourceKind = 'hp' | 'mp' | 'stamina';
export type ResourceDelta = Partial<Record<ResourceKind, number>>;
export type StaminaRecovery = {
  elapsedMs: number;
  perSecond: number;
  addPerSecond?: number;
  multiplierBps?: number;
  /** Carry in 1/10,000,000 stamina units; retain between intervals, discard at maximum. */
  remainder?: number;
};
const kinds = ['hp', 'mp', 'stamina'] as const;
const denominator = 10_000_000n;
function integer(value: number, signed = false): bigint {
  if (!Number.isSafeInteger(value) || (!signed && value < 0))
    throw new Error('Resource quantities must be safe integers');
  return BigInt(value);
}
/** Zero latches exhaustion until resumeAt (default ceil(max/10)); absent definitions remain legacy. */
export function staminaExhausted(
  resources: ResourceState,
  stamina: Character['stamina'],
  previous = false,
): boolean {
  if (!stamina) return false;
  const current = resources.stamina ?? 0;
  return current === 0 || (previous && current < (stamina.resumeAt ?? Math.ceil(stamina.max / 10)));
}

/** Sum simultaneous signed changes and recovery, then clamp once. Inputs are never mutated.
 * G-03 supplies already aggregated recovery adjustments; no status semantics live here.
 * A missing stamina field is never materialized by an effect or a recovery request.
 */
export function updateResources(
  before: ResourceState,
  limits: ResourceLimits,
  deltas: readonly ResourceDelta[] = [],
  recovery?: StaminaRecovery,
) {
  let recovered = 0n,
    remainder = 0;
  if (recovery && before.stamina !== undefined && limits.stamina !== undefined) {
    const rate = integer(recovery.perSecond) + integer(recovery.addPerSecond ?? 0, true);
    const multiplier = integer(recovery.multiplierBps ?? 10000);
    const carry = integer(recovery.remainder ?? 0);
    if (carry >= denominator) throw new Error('Invalid stamina recovery remainder');
    const amount = (rate > 0n ? rate : 0n) * multiplier * integer(recovery.elapsedMs) + carry;
    recovered = amount / denominator;
    remainder = Number(amount % denominator);
  }
  const resources = { ...before },
    actual: ResourceDelta = {};
  for (const kind of kinds) {
    const current = before[kind],
      maximum = limits[kind];
    if (current === undefined || maximum === undefined) continue;
    const value =
      deltas.reduce((sum, delta) => sum + integer(delta[kind] ?? 0, true), integer(current)) +
      (kind === 'stamina' ? recovered : 0n);
    const cap = integer(maximum);
    resources[kind] = Number(value < 0n ? 0n : value > cap ? cap : value);
    actual[kind] = resources[kind]! - current;
  }
  if (resources.stamina === limits.stamina) remainder = 0;
  return { resources, actual, remainder };
}

export type ResourceRequest = Partial<Record<ResourceKind, number | undefined>> & {
  uses?: { id: string; limit: number };
};
export type ResourceFailure = ResourceKind | 'uses';
type Reservation = { cost: Required<ResourceDelta>; uses: Record<string, number> };
const counters = (initial: Readonly<Record<string, number>> = {}) =>
  Object.assign(Object.create(null) as Record<string, number>, initial);

/** One budget per actor/declaration+movement interval. All consumers reserve against `available`.
 * Failed groups reserve nothing. Commit/cancel each key once; commits may refund unused motion.
 * Finish all holds before applying damage, periodic changes or recovery to the returned snapshot.
 * A started skill commits before launch; later fizzle has no refund. Uses=0 means unlimited.
 */
export class ResourceBudget {
  private current: ResourceState;
  private used: Record<string, number>;
  private readonly held = new Map<string, Reservation>();
  private readonly settled = new Set<string>();
  private useLimits = new Map<string, number>();
  private readonly staminaReady: boolean;
  constructor(
    resources: ResourceState,
    used: Readonly<Record<string, number>> = {},
    staminaReady = true,
  ) {
    this.current = { ...resources };
    this.used = counters(used);
    this.staminaReady = staminaReady;
  }
  get available(): ResourceState {
    const value = { ...this.current };
    for (const reservation of this.held.values())
      for (const kind of kinds)
        if (value[kind] !== undefined) value[kind]! -= reservation.cost[kind];
    return value;
  }
  reserve(
    key: string,
    requests: readonly ResourceRequest[],
  ): { ok: true } | { ok: false; reason: ResourceFailure } {
    if (this.held.has(key) || this.settled.has(key))
      throw new Error('Resource reservation key reused');
    const cost = { hp: 0, mp: 0, stamina: 0 },
      uses = counters();
    const pendingUses = counters(this.used);
    const limits = new Map(this.useLimits);
    for (const held of this.held.values())
      for (const [id, count] of Object.entries(held.uses))
        pendingUses[id] = (pendingUses[id] ?? 0) + count;
    let usesExceeded = false;
    for (const request of requests) {
      for (const kind of kinds) {
        integer(request[kind] ?? 0);
        cost[kind] += request[kind] ?? 0;
        integer(cost[kind]);
      }
      if (request.uses) {
        const { id, limit } = request.uses;
        integer(limit);
        if (limits.has(id) && limits.get(id) !== limit)
          throw new Error('Inconsistent resource use limit');
        limits.set(id, limit);
        uses[id] = (uses[id] ?? 0) + 1;
        if (limit && (pendingUses[id] ?? 0) + uses[id]! > limit) usesExceeded = true;
      }
    }
    const available = this.available;
    for (const kind of kinds)
      if (
        cost[kind] > (available[kind] ?? 0) ||
        (kind === 'stamina' && cost.stamina > 0 && !this.staminaReady)
      )
        return { ok: false, reason: kind };
    if (usesExceeded) return { ok: false, reason: 'uses' };
    this.useLimits = limits;
    this.held.set(key, { cost, uses });
    return { ok: true };
  }
  private take(key: string) {
    const held = this.held.get(key);
    if (!held) throw new Error('Resource reservation is not pending');
    this.held.delete(key);
    this.settled.add(key);
    return held;
  }
  cancel(key: string): void {
    this.take(key);
  }
  commit(key: string, actual: ResourceDelta = {}) {
    const held = this.held.get(key);
    if (!held) throw new Error('Resource reservation is not pending');
    const payment = { ...held.cost, ...actual };
    for (const kind of kinds) {
      integer(payment[kind]);
      if (payment[kind] > held.cost[kind])
        throw new Error('Resource settlement exceeds reservation');
    }
    this.take(key);
    const before = { ...this.current };
    for (const kind of kinds)
      if (this.current[kind] !== undefined) this.current[kind]! -= payment[kind];
    for (const [id, count] of Object.entries(held.uses))
      this.used[id] = (this.used[id] ?? 0) + count;
    return { before, after: { ...this.current } };
  }
  finish() {
    if (this.held.size) throw new Error('Unsettled resource reservations');
    return { resources: { ...this.current }, used: { ...this.used } };
  }
}
