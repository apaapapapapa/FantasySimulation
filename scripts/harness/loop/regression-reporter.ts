import type { Reporter } from 'vite-plus/test/reporters';

/** Mounted read-only by the controller. Hooks are deliberately unsupported for proof tests. */
export default class RegressionReporter implements Reporter {
  private hooksExecuted = false;
  private tests: { file: string; name: string; state: string; errors: string[] }[] = [];
  onHookStart() {
    this.hooksExecuted = true;
  }
  onTestCaseResult(test: Parameters<NonNullable<Reporter['onTestCaseResult']>>[0]) {
    const result = test.result();
    this.tests.push({
      file: test.module.moduleId,
      name: test.fullName,
      state: result.state,
      errors: (result.errors ?? []).map((error) => error.name ?? 'UnknownError'),
    });
  }
  onTestRunEnd(...args: Parameters<NonNullable<Reporter['onTestRunEnd']>>) {
    console.log(
      'FANTASY_REGRESSION_EXECUTION=' +
        JSON.stringify({
          schemaVersion: 1,
          hooksExecuted: this.hooksExecuted,
          unhandledErrors: args[1].length,
          tests: this.tests,
        }),
    );
  }
}
