import { withMockNowForTest } from "../../../../lib/time";
import { createRouteMocks } from "./route-test";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { createFixtureLifecycle } from "./fixture-lifecycle";
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
function legacyPublicRunOwner(
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
    await cleanupPublicRuns(context, actor, tokens, options);
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

export interface RunCleanupReceiptEntry {
  readonly id: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completionAcknowledged: boolean;
}

interface RunCleanupOptions {
  readonly beforeRuns?: () => Promise<void>;
  readonly afterRuns?: () => Promise<void>;
  readonly afterSuccessfulCleanup?: (
    receipt: readonly RunCleanupReceiptEntry[],
  ) => Promise<void>;
}

function throwRunCleanupErrors(errors: readonly unknown[]) {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Run cleanup failed");
  }
}

async function cleanupPublicRuns(
  context: TestContext,
  actor: ApiTestUser,
  tokens: ReadonlyMap<string, string>,
  options: RunCleanupOptions,
  priorErrors: readonly unknown[] = [],
) {
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
  const receipt: RunCleanupReceiptEntry[] = [];
  const settledRuns = await settleIncludingAbort(async () => {
    const runs = createRunsApi(context);
    const reads = createRunReadsApi(context);
    let page = await reads.requestListLogs(actor, { limit: 100 }, [200]);
    const all = [...page.body.data];
    const cursors = new Set<string>();
    while (page.body.pagination.hasMore) {
      const cursor = page.body.pagination.nextCursor;
      if (!cursor || (options.afterSuccessfulCleanup && cursors.has(cursor))) {
        throw new Error("Expected the public Run-list continuation cursor");
      }
      cursors.add(cursor);
      page = await reads.requestListLogs(actor, { limit: 100, cursor }, [200]);
      all.push(...page.body.data);
    }
    for (const run of all) {
      let completionAcknowledged = false;
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
        completionAcknowledged = true;
      }
      receipt.push({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        completionAcknowledged,
      });
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
  throwRunCleanupErrors(errors);
  if (priorErrors.length === 0 && options.afterSuccessfulCleanup) {
    await options.afterSuccessfulCleanup(receipt);
  }
}

interface StrictRunOptions extends RunCleanupOptions {
  readonly captureBaseline: () => () => void;
  readonly restoreEnvironment: () => void;
  readonly afterSuccessfulCleanup: (
    receipt: readonly RunCleanupReceiptEntry[],
  ) => Promise<void>;
  readonly clockTime?: number | (() => number);
  readonly continueAcceptedOperations?: boolean;
}

function captureRunEnvironment() {
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKey = env("SECRETS_KMS_KEY_ID");
  const runnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
  return () => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", runnerGroup);
  };
}

async function restoreRunBaseline(
  restoreOwner: () => void,
  restoreExternal: () => void,
) {
  const results = await Promise.all([
    settleIncludingAbort(restoreOwner),
    settleIncludingAbort(restoreExternal),
  ]);
  throwRunCleanupErrors(
    results.flatMap((result) => {
      return result.ok ? [] : [result.error];
    }),
  );
}

/** Explicit strict ownership. No automatic hook; the caller must join finish(). */
export function createPublicRunLifecycle(
  context: TestContext,
  actor: ApiTestUser,
  options: StrictRunOptions,
) {
  if (options.afterRuns || options.continueAcceptedOperations) {
    throw new Error("Strict Run cleanup forbids afterRuns and continuation");
  }
  const tokens = new Map<string, string>();
  const restoreOwner = captureRunEnvironment();
  let restoreBaseline: (() => Promise<void>) | undefined;
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
  function restoreAccepted() {
    restoreOwner();
    options.restoreEnvironment();
  }
  const lifecycle = createFixtureLifecycle({
    beforeDrain() {
      const ownerBaseline = captureRunEnvironment();
      const externalBaseline = options.captureBaseline();
      restoreBaseline = () => {
        return restoreRunBaseline(ownerBaseline, externalBaseline);
      };
      restoreAccepted();
    },
    async teardown(priorErrors) {
      if (!restoreBaseline) {
        return;
      }
      const restored = await settleIncludingAbort(restoreAccepted);
      const errors = restored.ok ? [] : [restored.error];
      const result = await settleIncludingAbort(() => {
        return scoped(() => {
          return cleanupPublicRuns(context, actor, tokens, options, [
            ...priorErrors,
            ...errors,
          ]);
        }, true);
      });
      if (!result.ok) {
        errors.push(result.error);
      }
      throwRunCleanupErrors(errors);
    },
    afterTeardown() {
      return restoreBaseline?.();
    },
  });
  return {
    run<T>(operation: () => Promise<T>) {
      return lifecycle.run(() => {
        return scoped(operation);
      });
    },
    finish: lifecycle.finish,
    async claim(runId: string) {
      const claim = await createRunsApi(context).claimRunnerJob(runId);
      tokens.set(runId, claim.sandboxToken);
      return claim;
    },
  };
}

function automaticStrictRunOwner(
  context: TestContext,
  actor: ApiTestUser,
  options: StrictRunOptions,
) {
  const lifecycle = createPublicRunLifecycle(context, actor, options);
  onTestFinished(() => {
    return lifecycle.finish();
  });
  return {
    run: lifecycle.run,
    claim: lifecycle.claim,
    cleanup(): Promise<void> {
      return Promise.reject(
        new Error("Strict Run cleanup is owned by fixture finalization"),
      );
    },
  };
}

type LegacyRunOptions = NonNullable<Parameters<typeof legacyPublicRunOwner>[2]>;

export function publicRunOwner(
  context: TestContext,
  actor: ApiTestUser,
  options: StrictRunOptions,
): ReturnType<typeof automaticStrictRunOwner>;
export function publicRunOwner(
  context: TestContext,
  actor: ApiTestUser,
  options?: LegacyRunOptions,
): ReturnType<typeof legacyPublicRunOwner>;
export function publicRunOwner(
  context: TestContext,
  actor: ApiTestUser,
  options: StrictRunOptions | LegacyRunOptions = {},
) {
  if ("afterSuccessfulCleanup" in options) {
    return automaticStrictRunOwner(context, actor, options);
  }
  return legacyPublicRunOwner(context, actor, options);
}
