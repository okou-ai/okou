import { withMockNowForTest } from "../../../../lib/time";
import { createRouteMocks } from "./route-test";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import {
  env,
  mockEnv,
  mockOptionalEnv,
  optionalEnv,
} from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { settleIncludingAbort } from "../../../utils";
import type { ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

/** Own the actual Runs of one unique public-flow actor, including failed setup. */
export function publicRunOwner(
  context: TestContext,
  actor: ApiTestUser,
  options: {
    readonly continueAcceptedOperations?: boolean;
    readonly restoreEnvironment?: () => void;
    readonly clockTime?: number | (() => number);
    readonly beforeRuns?: () => Promise<void>;
    readonly afterRuns?: () => Promise<void>;
  } = {},
) {
  let acceptedClockTime: number | undefined;
  function scoped<T>(operation: () => Promise<T>, cleanup = false): Promise<T> {
    const clockTime = cleanup
      ? acceptedClockTime
      : typeof options.clockTime === "function"
        ? options.clockTime()
        : options.clockTime;
    if (!cleanup) {
      acceptedClockTime = clockTime;
    }
    return clockTime === undefined
      ? operation()
      : withMockNowForTest(clockTime, operation);
  }
  const tokens = new Map<string, string>();
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKey = env("SECRETS_KMS_KEY_ID");
  const runnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
  let cleaned = false;
  function restoreEnvironment() {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
    if (runnerGroup) {
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", runnerGroup);
    }
    options.restoreEnvironment?.();
  }
  async function cleanup() {
    if (cleaned) {
      return;
    }
    restoreEnvironment();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const pendingWork = await settleIncludingAbort(flushWaitUntilForTest);
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const beforeRuns = await settleIncludingAbort(() => {
      return options.beforeRuns?.() ?? Promise.resolve();
    });
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const settledRuns = await settleIncludingAbort(async () => {
      const runs = createRunsApi(context);
      const reads = createRunReadsApi(context);
      let page = await reads.requestListLogs(actor, { limit: 100 }, [200]);
      const all = [...page.body.data];
      while (page.body.pagination.hasMore) {
        const cursor = page.body.pagination.nextCursor;
        if (!cursor) {
          throw new Error("Expected the public Run-list continuation cursor");
        }
        page = await reads.requestListLogs(
          actor,
          { limit: 100, cursor },
          [200],
        );
        all.push(...page.body.data);
      }
      for (const run of all) {
        if (["queued", "pending", "running"].includes(run.status)) {
          await runs.requestCancelRun(actor, run.id, [200]);
        }
        const token = tokens.get(run.id);
        if (token && !["completed", "failed", "timeout"].includes(run.status)) {
          await createWebhookCallbackApi(context).requestAgentComplete(
            { runId: run.id, exitCode: 1, error: "Run cancelled" },
            { authorization: `Bearer ${token}` },
            [200],
          );
        }
      }
    });
    const terminalWork = await settleIncludingAbort(flushWaitUntilForTest);
    const afterRuns = await settleIncludingAbort(() => {
      return options.afterRuns?.() ?? Promise.resolve();
    });
    const errors = [
      pendingWork,
      beforeRuns,
      settledRuns,
      terminalWork,
      afterRuns,
    ].flatMap((result) => {
      return result.ok ? [] : [result.error];
    });
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Run cleanup failed");
    }
    cleaned = true;
  }
  let previousCleanupRunnerGroup: string | undefined;
  const operations = createFixtureOperationOwner(
    async () => {
      const result = await settleIncludingAbort(() => {
        return scoped(cleanup, true);
      });
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousCleanupRunnerGroup);
      if (!result.ok) {
        throw result.error;
      }
    },
    { continueAcceptedOperations: options.continueAcceptedOperations },
  );
  // Finished callbacks run in reverse order, after testContext clears env in
  // afterEach. Restore the accepted requests' environment before draining them.
  onTestFinished(() => {
    previousCleanupRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
    restoreEnvironment();
  });
  return {
    run<T>(operation: () => Promise<T>) {
      return operations.run(() => {
        return scoped(operation);
      });
    },
    cleanup,
    async claim(runId: string) {
      const claim = await createRunsApi(context).claimRunnerJob(runId);
      tokens.set(runId, claim.sandboxToken);
      return claim;
    },
    rememberClaim(runId: string, sandboxToken: string) {
      tokens.set(runId, sandboxToken);
    },
  };
}
