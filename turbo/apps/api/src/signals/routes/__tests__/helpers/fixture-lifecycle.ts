import { AsyncLocalStorage } from "node:async_hooks";
import { settleIncludingAbort } from "../../../utils";

interface FixtureLifecycleOptions {
  readonly beforeDrain?: () => void;
  readonly teardown: (priorErrors: readonly unknown[]) => Promise<void>;
  readonly afterTeardown?: () => void | Promise<void>;
}

/** Explicit ownership: finish must be called outside owned work and callbacks. */
export function createFixtureLifecycle(options: FixtureLifecycleOptions) {
  const activeScope = new AsyncLocalStorage<{ active: boolean }>();
  const operations: Promise<unknown>[] = [];
  let closing = false;
  let finished: Promise<void> | undefined;

  async function scoped<T>(operation: () => T | Promise<T>): Promise<T> {
    const scope = { active: true };
    const result = await settleIncludingAbort(() => {
      return activeScope.run(scope, operation);
    });
    scope.active = false;
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }

  async function finishOwnedWork() {
    const preparation = await settleIncludingAbort(() => {
      return scoped(() => {
        options.beforeDrain?.();
      });
    });
    const errors: unknown[] = preparation.ok ? [] : [preparation.error];
    let drained = 0;
    while (drained < operations.length) {
      const accepted = operations.slice(drained);
      drained = operations.length;
      await Promise.allSettled(accepted);
    }
    const teardown = await settleIncludingAbort(() => {
      return scoped(() => {
        return options.teardown(errors);
      });
    });
    if (!teardown.ok) {
      errors.push(teardown.error);
    }
    const restoration = await settleIncludingAbort(() => {
      return scoped(() => {
        return options.afterTeardown?.();
      });
    });
    if (!restoration.ok) {
      errors.push(restoration.error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Fixture lifecycle failed");
    }
  }

  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      if (closing) {
        return Promise.reject(new Error("Fixture teardown already started"));
      }
      const pending = Promise.resolve().then(() => {
        return scoped(operation);
      });
      operations.push(pending);
      return pending;
    },
    finish(): Promise<void> {
      if (activeScope.getStore()?.active) {
        throw new Error(
          "Cannot finish a fixture from its owned work or callbacks",
        );
      }
      closing = true;
      finished ??= finishOwnedWork();
      return finished;
    },
  };
}
