import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { waitFor } from "@testing-library/react";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { beforeEach, expect, test, vi } from "vitest";

import {
  setupRealtime$,
  setAblyLoop$,
  setAblyPayloadLoop$,
  setRealtimeDegradedNotifier$,
  setSharedWorkerRealtimeBridge$,
} from "../realtime.ts";
import { clerk$, setupClerk$ } from "../auth.ts";
import { initializeAppVersion$ } from "../app-version.ts";
import { readClerkToken } from "../clerk-token.ts";
import { setRootSignal$ } from "../root-signal.ts";
import { setApiClientRuntime$ } from "../api-client-runtime.ts";
import { setAuthenticatedIdentity$ } from "../auth-context.ts";
import { subscribeChatThreadRealtime$ } from "../chat-page/chat-thread-remote-signals.ts";
import { testContext } from "./test-helpers.ts";
import {
  createChildAbortController,
  detach,
  Reason,
  settle,
} from "../utils.ts";
import type { SharedDatabaseBridge } from "../../shared-database/bridge.ts";
import type {
  ComputedKey,
  ComputedValue,
} from "../../shared-database/computed-key.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "../../shared-database/data-key.ts";
import type {
  SharedDatabaseRealtimeMessage,
  SharedDatabaseRealtimeScope,
} from "../../shared-database/protocol.ts";

const context = testContext();

beforeEach(() => {
  context.mocks.clerk();
  context.store.set(initializeAppVersion$, __OKOU_APP_VERSION__);
  context.store.set(setRootSignal$, context.signal);
  const clerk = context.store.get(clerk$);
  context.store.set(setApiClientRuntime$, {
    apiBaseUrl: location.origin,
    oauthApiBaseUrl: location.origin,
    getToken: async (signal) => {
      const resolvedClerk = await clerk;
      signal.throwIfAborted();
      return await readClerkToken(resolvedClerk, signal);
    },
  });
  context.store.set(setRealtimeDegradedNotifier$, () => {
    toast.error("Realtime connection degraded");
  });
});

const finishLoop$ = command((_ctx, _signal: AbortSignal) => {
  return true;
});

const keepAliveLoop$ = command((_ctx, _signal: AbortSignal) => {
  return Promise.resolve(false);
});

const noopInvalidation$ = command((): void => {});

const keepAlivePayloadLoop$ = command(
  (_ctx, _payload: unknown, _signal: AbortSignal) => {
    return Promise.resolve(false);
  },
);

const failSubscriptionInitialization$ = command(
  (_ctx, _signal: AbortSignal) => {
    throw new Error("subscription initialization failed");
  },
);

function mockSignedInUser(): void {
  const clerk = context.mocks.clerk();
  clerk.user(
    {
      id: "test-user-123",
      fullName: "Test User",
      email: "test@example.com",
    },
    { token: "test-token" },
  );
  clerk.organization({
    activeOrg: { id: "test-org-123", name: "Test Organization" },
    memberships: [{ id: "test-org-123" }],
  });
  context.store.set(
    setAuthenticatedIdentity$,
    Promise.resolve({
      userId: "test-user-123",
      orgId: "test-org-123",
      email: "test@example.com",
    }),
  );
}

async function setupAuthAndRealtime(): Promise<void> {
  await context.store.set(setupClerk$, context.signal);
  await context.store.set(setupRealtime$, context.signal);
}

function testSubscriber(): AbortController {
  // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
  return createChildAbortController(context.signal);
}

interface SharedWorkerRealtimeSubscription {
  readonly listener: (message: SharedDatabaseRealtimeMessage) => void;
  readonly scope: SharedDatabaseRealtimeScope;
  readonly topic: string;
}

class TestSharedWorkerRealtimeBridge implements SharedDatabaseBridge {
  readonly subscriptions = new Map<string, SharedWorkerRealtimeSubscription>();

  registerTab(): Promise<void> {
    return Promise.resolve();
  }

  subscribeRealtime(
    subscriptionId: string,
    scope: SharedDatabaseRealtimeScope,
    topic: string,
    listener: (message: SharedDatabaseRealtimeMessage) => void,
  ): Promise<void> {
    this.subscriptions.set(subscriptionId, { listener, scope, topic });
    return Promise.resolve();
  }

  unsubscribeRealtime(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
  }

  getComputed<TKey extends ComputedKey>(
    _computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    return Promise.reject(new Error("Computed data is not configured"));
  }

  query<TKey extends SharedDatabaseDataKey>(
    _query: SharedDatabaseQuery<TKey>,
    _signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    return Promise.reject(
      new Error("Shared database queries are not configured"),
    );
  }

  publish(
    scope: SharedDatabaseRealtimeScope,
    topic: string,
    data: unknown,
  ): void {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.scope === scope && subscription.topic === topic) {
        subscription.listener({ name: topic, data });
      }
    }
  }
}

test("Route app subscriptions through the SharedWorker without an App Ably client", async () => {
  mockSignedInUser();
  const bridge = new TestSharedWorkerRealtimeBridge();
  const subscriber = testSubscriber();
  let runs = 0;
  const loop$ = command((_ctx, _signal: AbortSignal) => {
    runs += 1;
    return true;
  });

  context.store.set(setSharedWorkerRealtimeBridge$, bridge);
  await context.store.set(setupRealtime$, context.signal);
  const loopPromise = context.store.set(
    setAblyLoop$,
    { topic: "connectorPermissionUpdated", loopCommand$: loop$ },
    subscriber.signal,
  );

  await vi.waitFor(() => {
    expect(bridge.subscriptions).toHaveLength(1);
  });
  expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(0);

  bridge.publish("user", "connectorPermissionUpdated", { revision: 1 });
  await expect(loopPromise).resolves.toBeUndefined();
  expect(runs).toBe(1);
  expect(bridge.subscriptions).toHaveLength(0);
});

test("A pending live-update listener starts after realtime connects", async () => {
  mockSignedInUser();
  const topic = "test:pending-resolve";
  let runs = 0;
  const loop$ = command((_ctx, _signal: AbortSignal) => {
    runs += 1;
    return true;
  });

  const loopPromise = context.store.set(
    setAblyLoop$,
    {
      topic,
      loopCommand$: loop$,
    },
    context.signal,
  );
  expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();

  await context.store.set(setupRealtime$, context.signal);

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  context.mocks.ably.trigger(topic);

  await expect(loopPromise).resolves.toBeUndefined();
  expect(runs).toBe(1);
  expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
});

test("Workspace live updates stay in the active workspace", async () => {
  mockSignedInUser();
  const topic = "test:org-pending-resolve";
  let runs = 0;
  const loop$ = command((_ctx, _signal: AbortSignal) => {
    runs += 1;
    return true;
  });

  const loopPromise = context.store.set(
    setAblyLoop$,
    {
      scope: "org",
      topic,
      loopCommand$: loop$,
    },
    context.signal,
  );
  await context.store.set(setupRealtime$, context.signal);

  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel("org:test-org-123", topic),
    ).toBeTruthy();
  });
  expect(
    context.mocks.ably.hasSubscriptionOnChannel("user:test-user-123", topic),
  ).toBeFalsy();
  context.mocks.ably.triggerOnChannel("org:test-org-123", topic);

  await expect(loopPromise).resolves.toBeUndefined();
  expect(runs).toBe(1);
});

test("Realtime authentication failure does not leave stale live updates", async () => {
  mockSignedInUser();
  context.mocks.api(platformRealtimeTokenContract.create, ({ respond }) => {
    return respond(500, {
      error: {
        message: "realtime token unavailable",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
  });

  const topic = "test:auth-failure";
  const loopPromise = context.store.set(
    setAblyLoop$,
    {
      topic,
      loopCommand$: finishLoop$,
    },
    context.signal,
  );
  const setupPromise = context.store.set(setupRealtime$, context.signal);

  await expect(setupPromise).rejects.toThrow(/Ably connection failed/);
  await expect(loopPromise).rejects.toThrow(/Ably connection failed/);
  expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
});

test("Live updates remain usable after the transport reconnects", async () => {
  mockSignedInUser();
  const topic = "test:reconnect";
  const subscriber = testSubscriber();
  let runs = 0;
  const loop$ = command((_ctx, _signal: AbortSignal) => {
    runs += 1;
    return false;
  });

  await setupAuthAndRealtime();
  const loopPromise = context.store.set(
    setAblyLoop$,
    {
      topic,
      loopCommand$: loop$,
    },
    subscriber.signal,
  );
  detach(loopPromise, Reason.Daemon, "test realtime loop");

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  context.mocks.ably.trigger(topic);
  await waitFor(() => {
    expect(runs).toBe(1);
  });

  context.mocks.ably.triggerReconnect();
  context.mocks.ably.trigger(topic);
  await waitFor(() => {
    expect(runs).toBe(2);
  });
});

test("A subscription created while the connection is suspended still starts", async () => {
  mockSignedInUser();
  const topic = "test:subscribe-while-suspended";
  const subscriber = testSubscriber();
  let runs = 0;
  const loop$ = command((_ctx, _signal: AbortSignal) => {
    runs += 1;
    return false;
  });

  await setupAuthAndRealtime();
  // Ably refuses to attach while suspended, so this subscription cannot go
  // live yet — but it must survive until the connection can carry it.
  context.mocks.ably.triggerConnectionState("suspended", {
    code: 80_003,
    message: "Unable to connect (network unreachable)",
  });

  const loopPromise = context.store.set(
    setAblyLoop$,
    { topic, loopCommand$: loop$ },
    subscriber.signal,
  );
  detach(loopPromise, Reason.Daemon, "suspended realtime loop");

  // The listener has to survive the whole offline episode; asserting it before
  // the reconnect is what keeps this test honest about the recovery.
  await vi.waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });

  context.mocks.ably.triggerConnectionState("connected");
  context.mocks.ably.trigger(topic);
  await waitFor(() => {
    expect(runs).toBe(1);
  });
});

test("A suspended connection keeps the listener instead of failing", async () => {
  mockSignedInUser();
  const topic = "test:suspended-no-failure";
  const subscriber = testSubscriber();

  await setupAuthAndRealtime();
  context.mocks.ably.triggerConnectionState("suspended", {
    code: 80_003,
    message: "Unable to connect (network unreachable)",
  });

  const loopPromise = context.store.set(
    setAblyLoop$,
    { topic, loopCommand$: keepAliveLoop$ },
    subscriber.signal,
  );
  let loopSettled = false;
  const observeLoop = async (): Promise<void> => {
    await settle(loopPromise);
    loopSettled = true;
  };
  detach(observeLoop(), Reason.Daemon, "suspended realtime loop");

  // The transport is unavailable, not broken. Dropping the listener here is
  // what used to strand the subscription: Ably reattaches the channel on
  // reconnect, but it cannot restore a listener the application removed.
  await vi.waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  expect(loopSettled).toBeFalsy();
});

test("Subscription initialization runs only after the channel attaches", async () => {
  mockSignedInUser();
  const topic = "test:initialize-after-attach";
  const subscriber = testSubscriber();
  let reconnected = false;
  const initializeOrder: string[] = [];
  const initialize$ = command((_ctx, _signal: AbortSignal) => {
    initializeOrder.push(reconnected ? "after-attach" : "before-attach");
    return false;
  });

  await setupAuthAndRealtime();
  context.mocks.ably.triggerConnectionState("suspended", {
    code: 80_003,
    message: "Unable to connect (network unreachable)",
  });

  detach(
    context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: keepAlivePayloadLoop$,
        initializeCommand$: initialize$,
      },
      subscriber.signal,
    ),
    Reason.Daemon,
    "initialize after attach",
  );

  // Catch-up must not run against a channel that cannot deliver messages yet,
  // or it would leave a gap for everything published in between.
  await vi.waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  expect(initializeOrder).toHaveLength(0);

  reconnected = true;
  context.mocks.ably.triggerConnectionState("connected");
  await waitFor(() => {
    expect(initializeOrder).toStrictEqual(["after-attach"]);
  });
});

test("A terminal channel failure still stops the subscription", async () => {
  mockSignedInUser();
  const topic = "test:terminal-channel-failure";
  const subscriber = testSubscriber();

  await setupAuthAndRealtime();
  context.mocks.ably.triggerConnectionState("suspended", {
    code: 80_003,
    message: "Unable to connect (network unreachable)",
  });
  const loopPromise = context.store.set(
    setAblyLoop$,
    { topic, loopCommand$: keepAliveLoop$ },
    subscriber.signal,
  );
  await vi.waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });

  // Waiting for `attached` must not swallow a terminal channel state:
  // authentication revocation keeps its existing terminal semantics.
  context.mocks.ably.triggerFailure("connection failed");

  const result = await settle(loopPromise);
  expect(result.ok).toBeFalsy();
});

test("A continuity gap re-reads the subscription baseline", async () => {
  mockSignedInUser();
  const topic = "test:continuity-gap";
  const subscriber = testSubscriber();
  let baselineReads = 0;
  const initialize$ = command((_ctx, _signal: AbortSignal) => {
    baselineReads += 1;
    return false;
  });

  await setupAuthAndRealtime();
  detach(
    context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: keepAlivePayloadLoop$,
        initializeCommand$: initialize$,
      },
      subscriber.signal,
    ),
    Reason.Daemon,
    "continuity gap loop",
  );
  await waitFor(() => {
    expect(baselineReads).toBe(1);
  });

  // Ably could not replay this reattach, so the subscription has to read its
  // baseline again; without it the tab keeps whatever it had before the gap.
  context.mocks.ably.triggerConnectionState("suspended", {
    code: 80_003,
    message: "Unable to connect (network unreachable)",
  });
  context.mocks.ably.triggerConnectionState("connected");

  await waitFor(() => {
    expect(baselineReads).toBe(2);
  });
});

test("A replayed reattach does not re-read the subscription baseline", async () => {
  mockSignedInUser();
  const topic = "test:continuity-preserved";
  const subscriber = testSubscriber();
  let baselineReads = 0;
  const initialize$ = command((_ctx, _signal: AbortSignal) => {
    baselineReads += 1;
    return false;
  });

  await setupAuthAndRealtime();
  detach(
    context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: keepAlivePayloadLoop$,
        initializeCommand$: initialize$,
      },
      subscriber.signal,
    ),
    Reason.Daemon,
    "continuity preserved loop",
  );
  await waitFor(() => {
    expect(baselineReads).toBe(1);
  });

  // Ably reports `resumed` when it replayed the gap itself. Re-reading here
  // would refetch on every brief network blip for no reason.
  context.mocks.ably.triggerResume();
  await vi.waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  expect(baselineReads).toBe(1);
});

test("A continuity gap pokes a topic loop", async () => {
  mockSignedInUser();
  const topic = "test:continuity-gap-topic";
  const subscriber = testSubscriber();
  let runs = 0;
  const loop$ = command((_ctx, _signal: AbortSignal) => {
    runs += 1;
    return false;
  });

  await setupAuthAndRealtime();
  detach(
    context.store.set(
      setAblyLoop$,
      { topic, loopCommand$: loop$, options: { runOnSubscribe: true } },
      subscriber.signal,
    ),
    Reason.Daemon,
    "continuity gap topic loop",
  );
  await waitFor(() => {
    expect(runs).toBe(1);
  });

  context.mocks.ably.triggerConnectionState("suspended", {
    code: 80_003,
    message: "Unable to connect (network unreachable)",
  });
  context.mocks.ably.triggerConnectionState("connected");

  await waitFor(() => {
    expect(runs).toBe(2);
  });
});

test("An update arriving during processing is not lost", async () => {
  mockSignedInUser();
  const topic = "test:in-flight-notification";
  const firstRunCanFinish = context.mocks.deferred<void>();
  let runs = 0;
  const loop$ = command(async (_ctx, signal: AbortSignal) => {
    runs += 1;
    if (runs === 1) {
      await firstRunCanFinish.promise;
      signal.throwIfAborted();
      return false;
    }
    return true;
  });

  await context.store.set(setupRealtime$, context.signal);
  const loopPromise = context.store.set(
    setAblyLoop$,
    {
      topic,
      loopCommand$: loop$,
    },
    context.signal,
  );

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  context.mocks.ably.trigger(topic);
  await waitFor(() => {
    expect(runs).toBe(1);
  });

  context.mocks.ably.trigger(topic);
  firstRunCanFinish.resolve();

  await expect(loopPromise).resolves.toBeUndefined();
  expect(runs).toBe(2);
});

test("A transient live-update error is retried", async () => {
  mockSignedInUser();
  const topic = "test:transient-loop-error";
  let runs = 0;
  const loop$ = command((_ctx, _signal: AbortSignal) => {
    runs += 1;
    if (runs === 1) {
      throw new Error("temporary loop failure");
    }
    return true;
  });

  await context.store.set(setupRealtime$, context.signal);
  const loopPromise = context.store.set(
    setAblyLoop$,
    {
      topic,
      loopCommand$: loop$,
    },
    context.signal,
  );

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  context.mocks.ably.trigger(topic);

  await expect(loopPromise).resolves.toBeUndefined();
  expect(runs).toBe(2);
});

test("Payload updates received during subscription initialization are applied", async () => {
  mockSignedInUser();
  const topic = "test:payload-initialization";
  const subscriber = testSubscriber();
  const payloads: unknown[] = [];
  const initializationStarted = context.mocks.deferred<void>();
  const initializationFinished = context.mocks.deferred<void>();
  const loop$ = command(
    (_ctx, payload: unknown, _signal: AbortSignal): boolean => {
      payloads.push(payload);
      return false;
    },
  );
  const initialize$ = command(
    async (_ctx, signal: AbortSignal): Promise<boolean> => {
      initializationStarted.resolve();
      await initializationFinished.promise;
      signal.throwIfAborted();
      return false;
    },
  );

  await setupAuthAndRealtime();
  const loopPromise = context.store.set(
    setAblyPayloadLoop$,
    {
      topic,
      loopCommand$: loop$,
      initializeCommand$: initialize$,
    },
    subscriber.signal,
  );
  detach(loopPromise, Reason.Daemon, "test realtime loop");

  await initializationStarted.promise;
  context.mocks.ably.trigger(topic, { connectorSlug: "gmail" });
  initializationFinished.resolve();
  await waitFor(() => {
    expect(payloads).toStrictEqual([{ connectorSlug: "gmail" }]);
  });
});

test("A permanently bad live update does not block later updates", async () => {
  mockSignedInUser();
  const topic = "test:poison-payload";
  const toastError = vi.spyOn(toast, "error").mockReturnValue("toast-id");
  const handled: unknown[] = [];
  let poisonAttempts = 0;
  const loop$ = command((_ctx, payload: unknown, _signal: AbortSignal) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "poison" in payload
    ) {
      poisonAttempts += 1;
      throw new Error("permanent payload failure");
    }
    handled.push(payload);
    return true;
  });

  await context.store.set(setupRealtime$, context.signal);
  const loopPromise = context.store.set(
    setAblyPayloadLoop$,
    {
      topic,
      loopCommand$: loop$,
    },
    context.signal,
  );

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  context.mocks.ably.trigger(topic, { poison: "first" });
  context.mocks.ably.trigger(topic, { poison: "second" });
  context.mocks.ably.trigger(topic, { messageId: "message-1" });

  await expect(loopPromise).resolves.toBeUndefined();
  expect(poisonAttempts).toBe(8);
  expect(handled).toStrictEqual([{ messageId: "message-1" }]);
  expect(toastError).toHaveBeenCalledTimes(1);
});

test("A persistent refresh error pauses until a new update", async () => {
  mockSignedInUser();
  const topic = "test:poison-notification";
  const toastError = vi.spyOn(toast, "error").mockReturnValue("toast-id");
  let runs = 0;
  const loop$ = command((_ctx, _signal: AbortSignal) => {
    runs += 1;
    if (runs <= 4) {
      throw new Error("permanent notification failure");
    }
    return true;
  });

  await context.store.set(setupRealtime$, context.signal);
  const loopPromise = context.store.set(
    setAblyLoop$,
    {
      topic,
      loopCommand$: loop$,
    },
    context.signal,
  );

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  context.mocks.ably.trigger(topic);

  await waitFor(() => {
    expect(toastError).toHaveBeenCalledTimes(1);
  });
  expect(runs).toBe(4);

  context.mocks.ably.trigger(topic);
  await expect(loopPromise).resolves.toBeUndefined();
  expect(runs).toBe(5);
});

test("Chat thread notifications invalidate their matching resources", async () => {
  mockSignedInUser();
  const threadId = "test-thread-invalidations";
  const subscriber = testSubscriber();
  const invalidated: string[] = [];
  const recordInvalidation = (name: string) => {
    return command((): void => {
      invalidated.push(name);
    });
  };

  await context.store.set(setupRealtime$, context.signal);
  detach(
    context.store.set(
      subscribeChatThreadRealtime$,
      {
        threadId,
        invalidations: {
          threadDetail: [
            recordInvalidation("thread-detail"),
            recordInvalidation("connector-preference"),
          ],
          automations: [recordInvalidation("automations")],
          artifacts: [recordInvalidation("artifacts")],
        },
        handlers: { onWorkflowsChanged$: keepAliveLoop$ },
      },
      subscriber.signal,
    ),
    Reason.Daemon,
    "test chat thread realtime invalidations",
  );

  await waitFor(() => {
    for (const topic of [
      "chatThreadDetailChanged",
      "chatThreadAutomationsChanged",
      "chatThreadArtifactsChanged",
      "chatThreadWorkflowsChanged",
    ]) {
      expect(
        context.mocks.ably.hasSubscription(`${topic}:${threadId}`),
      ).toBeTruthy();
    }
  });

  const notifications = [
    {
      topic: `chatThreadDetailChanged:${threadId}`,
      expected: ["thread-detail", "connector-preference"],
    },
    {
      topic: `chatThreadAutomationsChanged:${threadId}`,
      expected: ["thread-detail", "connector-preference", "automations"],
    },
    {
      topic: `chatThreadArtifactsChanged:${threadId}`,
      expected: [
        "thread-detail",
        "connector-preference",
        "automations",
        "artifacts",
      ],
    },
    {
      topic: `chatThreadArtifactsChanged:${threadId}`,
      expected: [
        "thread-detail",
        "connector-preference",
        "automations",
        "artifacts",
        "artifacts",
      ],
    },
  ] as const;
  for (const notification of notifications) {
    context.mocks.ably.trigger(notification.topic);
    await waitFor(() => {
      expect(invalidated).toStrictEqual(notification.expected);
    });
  }
});

test("An initial refresh failure does not destroy live subscriptions", async () => {
  mockSignedInUser();
  const threadId = "test-thread-initialization-failure";
  await context.store.set(setupRealtime$, context.signal);

  await expect(
    context.store.set(
      subscribeChatThreadRealtime$,
      {
        threadId,
        invalidations: {
          threadDetail: [noopInvalidation$],
          automations: [noopInvalidation$],
          artifacts: [noopInvalidation$],
        },
        handlers: {
          onWorkflowsChanged$: keepAliveLoop$,
          onSubscribed$: failSubscriptionInitialization$,
        },
      },
      context.signal,
    ),
  ).rejects.toThrow("subscription initialization failed");

  expect(
    context.mocks.ably.hasSubscription(
      `chatThreadAutomationsChanged:${threadId}`,
    ),
  ).toBeTruthy();
});
