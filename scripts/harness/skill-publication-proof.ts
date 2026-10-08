export type SkillProofIssue = {
  code:
    | 'missing-recipe'
    | 'invalid-recipe'
    | 'unregistered-node'
    | 'identity-mismatch'
    | 'unregistered-fixture'
    | 'missing-required-kind'
    | 'unbound-test'
    | 'unexecuted-test'
    | 'skipped-test'
    | 'failed-test'
    | 'stale-results'
    | 'incomplete-run';
  detail: string;
  causeCode?: string;
};
export type SkillTestExecution = {
  sourceSha: string;
  complete: boolean;
  outcomes: ReadonlyMap<string, readonly string[]>;
};
export type SkillNodeProof = {
  nodeId: string;
  registered: boolean;
  linked: boolean;
  passed: boolean;
  required: readonly string[];
  issues: SkillProofIssue[];
  tests: Array<{ id: string; file: string; name: string }>;
};

/** Bind validated recipe/fixture observations to actual execution, without loading the engine or dependencies. */
export function bindSkillProof(
  observed: SkillNodeProof,
  sourceSha: string,
  execution: SkillTestExecution | null,
): SkillNodeProof {
  const issues = observed.issues.filter(
    ({ code }) =>
      ![
        'unexecuted-test',
        'incomplete-run',
        'stale-results',
        'skipped-test',
        'failed-test',
      ].includes(code),
  );
  if (!observed.registered) return { ...observed, issues, linked: false, passed: false };
  let linked = observed.tests.length > 0 && !issues.some(({ code }) => code === 'unbound-test');
  for (const test of observed.tests) {
    const outcomes = execution?.outcomes.get(`${test.file}\n${test.name}`) ?? [];
    if (!outcomes.length) {
      linked = false;
      issues.push({ code: 'unexecuted-test', detail: test.id });
    } else if (outcomes.includes('failed')) issues.push({ code: 'failed-test', detail: test.id });
    else if (outcomes.some((status) => status !== 'passed'))
      issues.push({ code: 'skipped-test', detail: test.id });
  }
  if (execution && execution.sourceSha !== sourceSha)
    issues.push({ code: 'stale-results', detail: execution.sourceSha });
  if (!execution?.complete) issues.push({ code: 'incomplete-run', detail: sourceSha });
  return { ...observed, issues, linked, passed: !issues.length };
}
