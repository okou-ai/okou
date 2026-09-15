import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { clerk$, clerkUser$, setupClerk$ } from "./auth.ts";
import { setAuthenticatedIdentity$ } from "./auth-context.ts";
import { initializeChatThreadEventSource$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { setupUserPreferenceRealtime$ } from "./external/user-model-preference.ts";
import { setupModelPolicyRealtime$ } from "./external/model-policy-realtime.ts";
import { subscribePermissionUpdate$ } from "./permission-allow/permission-allow-signals.ts";
import {
  setRealtimeDegradedNotifier$,
  setSharedWorkerRealtimeBridge$,
  setupRealtime$,
} from "./realtime.ts";
import { i18n } from "../i18n/index.ts";
import { setupBillingRealtime$ } from "./okou-page/billing.ts";
import { subscribePresentationTemplatesChanged$ } from "./okou-page/presentation-template-library.ts";
import { subscribeCustomConnectorListChanged$ } from "./okou-page/settings/custom-connectors.ts";
import { subscribeSshChanged$ } from "./ssh.ts";
import {
  bridgeConnected$,
  installedSharedDatabaseBridge$,
} from "./shared-database-bridge-state.ts";
import { setupMorningBriefRealtime$ } from "./okou-page/settings/morning-brief-preference.ts";
import { initializeUserTimezone$ } from "./okou-page/settings/user-preferences.ts";
import type { SharedDatabaseBridge } from "../shared-database/bridge.ts";
import { waitForOperation } from "./utils.ts";

const runAppRealtimeDaemons$ = command(
  async (
    { set },
    initialization: Promise<SharedDatabaseBridge | null>,
    signal: AbortSignal,
  ): Promise<void> => {
    const bridge = await waitForOperation(initialization, signal);
    signal.throwIfAborted();
    if (!bridge) {
      return;
    }
    await Promise.all([
      set(subscribePermissionUpdate$, signal),
      set(setupBillingRealtime$, signal),
      set(setupUserPreferenceRealtime$, signal),
      set(setupModelPolicyRealtime$, signal),
      set(setupMorningBriefRealtime$, signal),
      set(subscribeCustomConnectorListChanged$, signal),
      set(subscribeSshChanged$, signal),
    ]);
  },
);

const initializeAuthenticatedRealtime$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<SharedDatabaseBridge | null> => {
    const [, user] = await waitForOperation(
      Promise.all([set(setupClerk$, signal), get(clerkUser$)]),
      signal,
    );
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!user || !clerk.organization) {
      return null;
    }
    set(
      setAuthenticatedIdentity$,
      Promise.resolve({
        userId: user.id,
        orgId: clerk.organization.id,
        email: user.primaryEmailAddress?.emailAddress,
      }),
    );
    set(setRealtimeDegradedNotifier$, () => {
      toast.error(
        i18n.t(($) => {
          return $.global.realtime.degraded;
        }),
      );
    });

    await get(bridgeConnected$);
    signal.throwIfAborted();
    const bridge = get(installedSharedDatabaseBridge$);
    set(setSharedWorkerRealtimeBridge$, bridge);
    await set(setupRealtime$, signal);
    signal.throwIfAborted();
    return bridge;
  },
);

/** Run user-scoped application realtime services for the root lifecycle. */
export const runAuthenticatedRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const initialization = set(initializeAuthenticatedRealtime$, signal);
    // Install the catalog's operation before authentication or bridge setup can
    // settle, so every startup failure reaches its consumers.
    const templates = set(
      subscribePresentationTemplatesChanged$,
      initialization,
      signal,
    );
    await Promise.all([
      templates,
      set(runAppRealtimeDaemons$, initialization, signal),
    ]);
  },
);

/** Complete finite authenticated data setup while the initial route loads. */
export const setupAuthenticatedBootstrapData$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const user = await get(clerkUser$);
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!user || !clerk.organization) {
      return;
    }
    await get(bridgeConnected$);
    signal.throwIfAborted();
    await Promise.all([
      set(initializeChatThreadEventSource$, signal),
      set(initializeUserTimezone$, signal),
    ]);
  },
);
