import type { DeepReadonly } from './canonical.ts';
import type { Definition, RevisionRef } from './contracts.ts';

/** Transform dependencies must be validated and saved with the same revision closure as abilities. */
export function statusTransformationRefs(
  status: DeepReadonly<Definition<'status'>>,
): DeepReadonly<RevisionRef>[] {
  return (status.reactions ?? []).flatMap((r) =>
    r.response.kind === 'transform' ? [r.response.status] : [],
  );
}
