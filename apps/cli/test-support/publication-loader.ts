import { registerHooks } from 'node:module';

// A real CLI process must succeed with all execution/database imports unavailable.
registerHooks({
  resolve(specifier, context, next) {
    if (
      /better-sqlite3|drizzle|node:sqlite|@fantasy\/engine|batch-plan|batch-runner|battle-runtime|\/store\./.test(
        specifier,
      )
    )
      throw new Error('Execution/database import forbidden during export');
    return next(specifier, context);
  },
});
