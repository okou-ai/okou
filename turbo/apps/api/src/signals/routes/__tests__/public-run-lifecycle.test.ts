import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { expect, test, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { createFixtureLifecycle } from "./helpers/fixture-lifecycle";
import {
  createPublicRunLifecycle,
  publicRunOwner,
  type RunCleanupReceiptEntry,
} from "./helpers/public-run-owner";

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);

// Actor IDs isolate business state; this helper uses shared PostgreSQL.
async function onboardIsolatedActor(actor: ApiTestUser) {
  api.mockClerkUsers([actor]);
  api.acceptAgentStorageWrites();
  const app = await setupApp({
    context,
    routes: onboardingCompleteRoutes,
  });
  context.signal.throwIfAborted();
  await accept(
    app(onboardingCompleteContract).complete({
      headers: api.authenticate(actor),
      body: {},
    }),
    [200],
  );
  context.signal.throwIfAborted();
}

function strictOptions(events: string[]) {
  return {
    captureBaseline() {
      const restore = captureConnectorExternalState(context);
      return () => {
        restore();
        events.push("baseline");
      };
    },
    restoreEnvironment() {
      events.push("restore");
    },
    afterSuccessfulCleanup(_receipt: readonly RunCleanupReceiptEntry[]) {
      events.push("finalize");
      return Promise.resolve();
    },
  };
}

test("fixture lifecycle: drains accepted work and rejects late admission", async () => {
  const release = createDeferredPromise<void>(context.signal);
  const events: string[] = [];
  const lifecycle = createFixtureLifecycle({
    beforeDrain() {
      events.push("prepare");
    },
    teardown() {
      events.push("teardown");
      return Promise.resolve();
    },
    afterTeardown() {
      events.push("restore");
    },
  });
  const work = lifecycle.run(async () => {
    await release.promise;
    context.signal.throwIfAborted();
    events.push("work");
    return 42;
  });
  const finish = lifecycle.finish();
  const late = settleIncludingAbort(() => {
    return lifecycle.run(() => {
      events.push("late");
      return Promise.resolve();
    });
  });
  release.resolve();
  const results = await Promise.all([
    settleIncludingAbort(work),
    late,
    settleIncludingAbort(finish),
  ]);
  expect(results[0]).toStrictEqual({ ok: true, value: 42 });
  expect(results[1]).toMatchObject({
    ok: false,
    error: new Error("Fixture teardown already started"),
  });
  expect(results[2]).toStrictEqual({ ok: true, value: undefined });
  expect(events).toStrictEqual(["prepare", "work", "teardown", "restore"]);
  expect(lifecycle.finish()).toBe(finish);
  await finish;
});

test("fixture lifecycle: rejects owned-work and teardown reentry without deadlock", async () => {
  const started = createDeferredPromise<void>(context.signal);
  const observed: unknown[] = [];
  const lifecycle = createFixtureLifecycle({
    async teardown() {
      const result = await settleIncludingAbort(() => {
        return lifecycle.finish();
      });
      observed.push(result);
    },
  });
  const work = lifecycle.run(async () => {
    const result = await settleIncludingAbort(() => {
      return lifecycle.finish();
    });
    observed.push(result);
    started.resolve();
  });
  await started.promise;
  context.signal.throwIfAborted();
  const finish = lifecycle.finish();
  await Promise.all([work, finish]);
  expect(observed).toHaveLength(2);
  for (const result of observed) {
    expect(result).toMatchObject({
      ok: false,
      error: new Error(
        "Cannot finish a fixture from its owned work or callbacks",
      ),
    });
  }
  expect(lifecycle.finish()).toBe(finish);
});

test("fixture lifecycle: caches the complete failed finish and original error", async () => {
  const failure = new DOMException("owned fixture aborted", "AbortError");
  const events: string[] = [];
  const lifecycle = createFixtureLifecycle({
    teardown() {
      events.push("teardown");
      throw failure;
    },
    afterTeardown() {
      events.push("restore");
    },
  });
  const finish = lifecycle.finish();
  const repeated = lifecycle.finish();
  const result = await settleIncludingAbort(finish);
  const later = await settleIncludingAbort(lifecycle.finish());
  expect(repeated).toBe(finish);
  expect(result).toStrictEqual({ ok: false, error: failure });
  expect(later).toStrictEqual(result);
  if (!result.ok && !later.ok) {
    expect(result.error).toBe(failure);
    expect(later.error).toBe(failure);
  }
  expect(events).toStrictEqual(["teardown", "restore"]);
});

test("fixture lifecycle: strict cleanup lists real Runs but skips finalization after failure", async () => {
  const actor = api.user();
  const events: string[] = [];
  const failure = new Error("fixture beforeRuns failed");
  const owner = createPublicRunLifecycle(context, actor, {
    ...strictOptions(events),
    beforeRuns() {
      events.push("beforeRuns");
      throw failure;
    },
  });
  const setup = await settleIncludingAbort(() => {
    return owner.run(() => {
      return onboardIsolatedActor(actor);
    });
  });
  const finish = owner.finish();
  const result = await settleIncludingAbort(finish);
  const repeated = owner.finish();
  const again = await settleIncludingAbort(repeated);
  expect(setup).toStrictEqual({ ok: true, value: undefined });
  expect(result).toStrictEqual({ ok: false, error: failure });
  expect(again).toStrictEqual(result);
  if (!result.ok) {
    expect(result.error).toBe(failure);
  }
  expect(repeated).toBe(finish);
  expect(events).toStrictEqual([
    "restore",
    "restore",
    "beforeRuns",
    "baseline",
  ]);
  const listed = await createRunReadsApi(context).requestListLogs(
    actor,
    { limit: 100 },
    [200],
  );
  context.signal.throwIfAborted();
  expect(listed.body.data).toStrictEqual([]);
});

test("fixture lifecycle: preserves ordered preparation cleanup and restoration errors", async () => {
  const actor = api.user();
  const events: string[] = [];
  const preparation = new Error("fixture preparation failed");
  const cleanup = new AggregateError(
    [new Error("first"), new Error("second")],
    "fixture cleanup failed",
  );
  const restoration = new Error("fixture restoration failed");
  const defaults = strictOptions(events);
  let restores = 0;
  const owner = createPublicRunLifecycle(context, actor, {
    ...defaults,
    captureBaseline() {
      const restore = defaults.captureBaseline();
      return () => {
        restore();
        throw restoration;
      };
    },
    restoreEnvironment() {
      restores++;
      if (restores === 1) {
        throw preparation;
      }
    },
    beforeRuns() {
      throw cleanup;
    },
  });
  const setup = await settleIncludingAbort(() => {
    return owner.run(() => {
      return onboardIsolatedActor(actor);
    });
  });
  const finish = owner.finish();
  const result = await settleIncludingAbort(finish);
  const again = await settleIncludingAbort(owner.finish());
  expect(setup).toStrictEqual({ ok: true, value: undefined });
  expect(result.ok).toBeFalsy();
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(AggregateError);
    if (!(result.error instanceof AggregateError)) {
      throw result.error;
    }
    const error = result.error;
    expect(error.errors).toStrictEqual([preparation, cleanup, restoration]);
    expect(error.errors[0]).toBe(preparation);
    expect(error.errors[1]).toBe(cleanup);
    expect(error.errors[2]).toBe(restoration);
    if (!again.ok) {
      expect(again.error).toBe(error);
    }
  }
  expect(events).toStrictEqual(["baseline"]);
  expect(restores).toBe(2);
  expect(owner.finish()).toBe(finish);
});

test("fixture lifecycle: failed baseline capture retains identities and skips cleanup", async () => {
  const actor = api.user();
  const events: string[] = [];
  const failure = new Error("fixture baseline unavailable");
  const owner = createPublicRunLifecycle(context, actor, {
    ...strictOptions(events),
    captureBaseline() {
      throw failure;
    },
    beforeRuns() {
      events.push("beforeRuns");
      return Promise.resolve();
    },
  });
  const setup = await settleIncludingAbort(() => {
    return owner.run(() => {
      return onboardIsolatedActor(actor);
    });
  });
  const result = await settleIncludingAbort(owner.finish());
  expect(setup).toStrictEqual({ ok: true, value: undefined });
  expect(result).toStrictEqual({ ok: false, error: failure });
  if (!result.ok) {
    expect(result.error).toBe(failure);
  }
  expect(events).toStrictEqual([]);
});

test("fixture lifecycle: finalizes a real empty workspace once and restores its baseline", async () => {
  const actor = api.user();
  const events: string[] = [];
  const baselineGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
  const owner = createPublicRunLifecycle(context, actor, {
    ...strictOptions(events),
    async afterSuccessfulCleanup(receipt) {
      expect(receipt).toStrictEqual([]);
      events.push("finalize");
      context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
        id: actor.orgId,
      });
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        { data: [{ publicUserData: { userId: actor.userId } }] },
      );
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.invoices.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      const deleted = await api.deleteOrg(actor);
      context.signal.throwIfAborted();
      expect(deleted).toStrictEqual({ message: "Organization deleted" });
    },
  });
  const setup = await settleIncludingAbort(() => {
    return owner.run(() => {
      return onboardIsolatedActor(actor);
    });
  });
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "lifecycle-baseline");
  const finish = owner.finish();
  const result = await settleIncludingAbort(finish);
  const again = await settleIncludingAbort(owner.finish());
  const restored = optionalEnv("RUNNER_DEFAULT_GROUP");
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", baselineGroup);
  expect(setup).toStrictEqual({ ok: true, value: undefined });
  expect(result).toStrictEqual({ ok: true, value: undefined });
  expect(again).toStrictEqual(result);
  expect(owner.finish()).toBe(finish);
  expect(events).toStrictEqual(["restore", "restore", "finalize", "baseline"]);
  expect(restored).toBe("lifecycle-baseline");
});

test("fixture lifecycle: default manual cleanup remains void and idempotent", async () => {
  const actor = api.user();
  let passes = 0;
  onTestFinished(() => {
    expect(passes).toBe(1);
  });
  const owner = publicRunOwner(context, actor, {
    afterRuns() {
      passes++;
      return Promise.resolve();
    },
  });
  const setup = await settleIncludingAbort(() => {
    return owner.run(() => {
      return onboardIsolatedActor(actor);
    });
  });
  const first = await settleIncludingAbort(owner.cleanup());
  const second = await settleIncludingAbort(owner.cleanup());
  expect(setup).toStrictEqual({ ok: true, value: undefined });
  expect(first).toStrictEqual({ ok: true, value: undefined });
  expect(second).toStrictEqual(first);
  expect(passes).toBe(1);
});

test("fixture lifecycle: default manual failure remains eligible for automatic cleanup", async () => {
  const actor = api.user();
  const failure = new Error("manual fixture phase failed");
  let passes = 0;
  let allowCleanup = false;
  onTestFinished(() => {
    expect(passes).toBe(2);
  });
  const owner = publicRunOwner(context, actor, {
    beforeRuns() {
      passes++;
      if (!allowCleanup) {
        throw failure;
      }
      return Promise.resolve();
    },
  });
  const setup = await settleIncludingAbort(() => {
    return owner.run(() => {
      return onboardIsolatedActor(actor);
    });
  });
  const result = await settleIncludingAbort(owner.cleanup());
  allowCleanup = true;
  expect(setup).toStrictEqual({ ok: true, value: undefined });
  expect(result).toStrictEqual({ ok: false, error: failure });
  if (!result.ok) {
    expect(result.error).toBe(failure);
  }
  expect(passes).toBe(1);
});

test("fixture lifecycle: strict guards preserve the single automatic cleanup owner", async () => {
  const actor = api.user();
  const events: string[] = [];
  const options = strictOptions(events);
  expect(() => {
    return createPublicRunLifecycle(context, actor, {
      ...options,
      continueAcceptedOperations: true,
    });
  }).toThrow("Strict Run cleanup forbids afterRuns and continuation");
  expect(() => {
    return createPublicRunLifecycle(context, actor, {
      ...options,
      afterRuns: () => {
        events.push("legacy");
        return Promise.resolve();
      },
    });
  }).toThrow("Strict Run cleanup forbids afterRuns and continuation");
  onTestFinished(() => {
    expect(events).toStrictEqual([
      "restore",
      "restore",
      "finalize",
      "baseline",
    ]);
  });
  const owner = publicRunOwner(context, actor, options);
  const manual = await settleIncludingAbort(owner.cleanup());
  expect(manual).toMatchObject({
    ok: false,
    error: new Error("Strict Run cleanup is owned by fixture finalization"),
  });
  expect(events).toStrictEqual([]);
  await owner.run(() => {
    return onboardIsolatedActor(actor);
  });
});
