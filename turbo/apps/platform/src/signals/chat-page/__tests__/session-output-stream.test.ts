import { computed, state } from "ccstate";
import { waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { sessionOutputChannelName } from "@okouai/api-contracts/contracts/realtime";

import { installMockedClerkBootstrap } from "../../../__tests__/mock-auth.ts";
import { initializeAppVersion$ } from "../../app-version.ts";
import { setApiClientRuntime$ } from "../../api-client-runtime.ts";
import { clerk$, setupClerk$ } from "../../auth.ts";
import { setAuthenticatedIdentity$ } from "../../auth-context.ts";
import { readClerkToken } from "../../clerk-token.ts";
import { setFeatureSwitchState$ } from "../../external/feature-switch-state.ts";
import { setupRealtime$ } from "../../realtime.ts";
import { setRootSignal$ } from "../../root-signal.ts";
import { resetSignal } from "../../utils.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { notifyChatEventsChanged$ } from "../chat-event-change-registry.ts";
import type { ChatEvent } from "../chat-event-types.ts";
import { createSessionOutputStreamSignals } from "../session-output-stream.ts";

const context = testContext();

const USER_ID = "test-user-123";
const ORG_ID = "test-org-123";
const THREAD_ID = "b0000000-0000-4000-a000-000000000901";
const FIRST_RUN_ID = "d0000000-0000-4000-a000-000000000911";
const SECOND_RUN_ID = "d0000000-0000-4000-a000-000000000912";

beforeEach(() => {
  context.mocks.clerk();
  installMockedClerkBootstrap(context.signal);
  context.store.set(initializeAppVersion$, __OKOU_APP_VERSION__);
  context.store.set(setRootSignal$, context.signal);
  const clerk = context.store.get(clerk$);
  context.store.set(setApiClientRuntime$, {
    apiBaseUrl: location.origin,
    oauthApiBaseUrl: location.origin,
    getToken: async (signal) => {
      const resolvedClerk = await clerk;
      signal?.throwIfAborted();
      return await readClerkToken(resolvedClerk, signal);
    },
  });
});

async function setupStreamingViewer(): Promise<void> {
  const clerk = context.mocks.clerk();
  clerk.user(
    { id: USER_ID, fullName: "Test User", email: "test@example.com" },
    { token: "test-token" },
  );
  clerk.organization({
    activeOrg: { id: ORG_ID, name: "Test Organization" },
    memberships: [{ id: ORG_ID }],
  });
  context.store.set(
    setAuthenticatedIdentity$,
    Promise.resolve({
      userId: USER_ID,
      orgId: ORG_ID,
      email: "test@example.com",
    }),
  );
  await context.store.set(setupClerk$, context.signal);
  await context.store.set(setupRealtime$, context.signal);
  context.store.set(setFeatureSwitchState$, {
    ...getAllFeatureStates(),
    [FeatureSwitchKey.SessionOutputStreaming]: true,
  });
}

function promptEvent(runId: string, seqId: number): ChatEvent {
  return {
    id: `prompt-${runId}`,
    threadId: THREAD_ID,
    eventType: "input.prompt",
    content: null,
    runId,
    seqId,
    createdAt: `2026-08-01T10:00:0${String(seqId)}.000Z`,
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: "Prepare a report" }],
    },
  };
}

function completedEvent(runId: string, seqId: number): ChatEvent {
  return {
    id: `completed-${runId}`,
    threadId: THREAD_ID,
    eventType: "run.completed",
    content: null,
    runId,
    runLifecycleEvent: "completed",
    seqId,
    createdAt: `2026-08-01T10:00:0${String(seqId)}.000Z`,
  };
}

function channelOf(runId: string): string {
  return sessionOutputChannelName(USER_ID, ORG_ID, runId);
}

test("A run change during channel attachment keeps only the latest run subscribed", async () => {
  await setupStreamingViewer();
  const events$ = state<ChatEvent[]>([promptEvent(FIRST_RUN_ID, 1)]);
  const chatEvents$ = computed((get) => {
    return get(events$);
  });
  const signals = createSessionOutputStreamSignals(THREAD_ID, chatEvents$);
  const resetViewer$ = resetSignal();
  const viewerSignal = context.store.set(resetViewer$, context.signal);
  const attaching = context.mocks.ably.deferSubscribeOnChannel(
    channelOf(FIRST_RUN_ID),
    FIRST_RUN_ID,
  );
  context.store.set(signals.subscribe$, viewerSignal);
  await attaching.started;

  context.store.set(events$, [
    promptEvent(FIRST_RUN_ID, 1),
    completedEvent(FIRST_RUN_ID, 2),
    promptEvent(SECOND_RUN_ID, 3),
  ]);
  const resetNotifier$ = resetSignal();
  const notifierSignal = context.store.set(resetNotifier$, context.signal);
  await context.store.set(
    notifyChatEventsChanged$,
    chatEvents$,
    notifierSignal,
  );
  // Finishing a change notification must not cancel the route's new subscription.
  context.store.set(resetNotifier$);
  attaching.attach();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        channelOf(SECOND_RUN_ID),
        SECOND_RUN_ID,
      ),
    ).toBeTruthy();
  });
  expect(
    context.mocks.ably.hasSubscriptionOnChannel(
      channelOf(FIRST_RUN_ID),
      FIRST_RUN_ID,
    ),
  ).toBeFalsy();
  context.store.set(resetViewer$);
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        channelOf(SECOND_RUN_ID),
        SECOND_RUN_ID,
      ),
    ).toBeFalsy();
  });
});
