import { z } from 'zod';
import data from './interference.json' with { type: 'json' };
import { MechanicIdSchema, type MechanicId } from './mechanics.ts';
import { deepFreeze } from './canonical.ts';

const rule = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const summary = z.string().min(1).max(1000);
const CaseSchema = z.discriminatedUnion('state', [
  z.strictObject({ when: rule, state: z.literal('defined'), ruleId: rule, summary }),
  z.strictObject({ when: rule, state: z.literal('independent'), reason: summary }),
  z.strictObject({ when: rule, state: z.literal('unresolved'), ruleId: rule, summary }),
  z.strictObject({ when: rule, state: z.literal('rejected'), reason: summary }),
]);
export const InterferenceTableSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    mechanics: z
      .array(
        z.strictObject({
          id: MechanicIdSchema,
          generation: z.enum(['legacy', 'p6']),
          implemented: z.boolean(),
          standardReady: z.boolean(),
          class: z.enum(['standard', 'experimental', 'reserved']),
          summary,
        }),
      )
      .length(MechanicIdSchema.options.length),
    predicates: z.record(rule, summary),
    cells: z
      .array(
        z.strictObject({
          row: MechanicIdSchema,
          column: MechanicIdSchema,
          cases: z.array(CaseSchema).min(1).max(8),
        }),
      )
      .length(MechanicIdSchema.options.length ** 2),
  })
  .superRefine((table, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (new Set(table.mechanics.map((m) => m.id)).size !== table.mechanics.length)
      bad('Duplicate or missing mechanic');
    const cells = new Set<string>();
    for (const cell of table.cells) {
      const key = `${cell.row}/${cell.column}`;
      if (cells.has(key)) bad('Duplicate interference cell');
      cells.add(key);
      const predicates = cell.cases.map((c) => c.when);
      if (new Set(predicates).size !== predicates.length) bad('Duplicate cell predicate');
      if (!['always', 'otherwise'].includes(predicates.at(-1)!))
        bad('Missing exhaustive final case');
      if (predicates.slice(0, -1).some((p) => !(p in table.predicates)))
        bad('Unknown cell predicate');
      if (predicates.at(-1) === 'always' && predicates.length !== 1) bad('Unreachable cell case');
      if (cell.cases.some((c) => c.state === 'unresolved' && c.when !== c.ruleId))
        bad('Unresolved predicate must identify the actual resolver rule');
    }
    for (const mechanic of table.mechanics) {
      if (mechanic.standardReady && (!mechanic.implemented || mechanic.class !== 'standard'))
        bad('Invalid standard readiness');
      if (mechanic.class === 'reserved' && mechanic.implemented)
        bad('Reserved mechanic implemented');
      if (mechanic.generation === 'p6' && mechanic.standardReady) {
        const required = new Set(
          table.mechanics
            .filter((m) => m.implemented && (m.generation === 'legacy' || m.standardReady))
            .map((m) => m.id),
        );
        if (
          table.cells.some(
            (cell) =>
              ((cell.row === mechanic.id && required.has(cell.column)) ||
                (cell.column === mechanic.id && required.has(cell.row))) &&
              cell.cases.some((c) => c.state !== 'defined' && c.state !== 'independent'),
          )
        )
          bad('New standard mechanic has unresolved or rejected accepted pairs');
      }
      if (
        !mechanic.implemented &&
        table.cells.some(
          (cell) =>
            (cell.row === mechanic.id || cell.column === mechanic.id) &&
            cell.cases.some((c) => c.state !== 'rejected'),
        )
      )
        bad('Unimplemented pair must reject admission');
    }
  });
export const interferenceTable = deepFreeze(InterferenceTableSchema.parse(data));
export const mechanicRegistry = new Map(interferenceTable.mechanics.map((m) => [m.id, m]));
const cells = new Map(interferenceTable.cells.map((cell) => [`${cell.row}/${cell.column}`, cell]));
export const interferenceCell = (left: MechanicId, right: MechanicId) =>
  cells.get(`${left}/${right}`)!;
