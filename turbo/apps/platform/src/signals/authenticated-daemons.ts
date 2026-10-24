import { command } from "ccstate";
import type { SharedDatabaseBridge } from "../shared-database/bridge.ts";
import { setAuthenticatedIdentity$ } from "./auth-context.ts";
import { clerk$, clerkUser$, setupClerk$ } from "./auth.ts";
import { initializeChatThreadEventSource$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { setupChatSyncRecovery$ } from "./chat-sync.ts";
import { subscribeCloudflareAccessChanged$ } from "./cloudflare-access.ts";
import { subscribeTailscaleChanged$ } from "./tailscale.ts";
import { setupRunModelRealtime$ } from "./external/run-model-realtime.ts";
import { setupUserPreferenceRealtime$ } from "./external/user-model-preference.ts";
import { setupBillingRealtime$ } from "./okou-page/billing.ts";
import { subscribeAgentConnectorAccess$ } from "./okou-page/composer-agent-connectors.ts";
import { subscribeCustomTemplatesChanged$ } from "./okou-page/custom-template-library.ts";
import { setupGetStartedRewards$ } from "./okou-page/get-started.ts";
import { subscribePresentationTemplatesChanged$ } from "./okou-page/presentation-template-library.ts";
import { subscribePermissionUpdate$ } from "./permission-allow/permission-allow-signals.ts";
import { setSharedWorkerRealtimeBridge$, setupRealtime$ } from "./realtime.ts";
import {
  bridgeConnected$,
  installedSharedDatabaseBridge$,
} from "./shared-database-bridge-state.ts";
import { subscribeVncObservations$ } from "./vnc.ts";
import { detach, Reason } from "./utils.ts";

const runAppRealtimeDaemons$ = command(
  async (
    { set },
    initialization: Promise<SharedDatabaseBridge | null>,
    signal: AbortSignal,
  ): Promise<void> => {
    const bridge = await initialization;
    signal.throwIfAborted();
    if (!bridge) {
      return;
    }
    set(setupGetStartedRewards$, signal);
    set(subscribePermissionUpdate$, signal);
    set(setupBillingRealtime$, signal);
    set(setupUserPreferenceRealtime$, signal);
    set(setupRunModelRealtime$, signal);
    set(subscribeAgentConnectorAccess$, signal);
    set(subscribeCustomTemplatesChanged$, signal);
    set(subscribeVncObservations$, signal);
    set(subscribeCloudflareAccessChanged$, signal);
    set(subscribeTailscaleChanged$, signal);
  },
);

const initializeAuthenticatedRealtime$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<SharedDatabaseBridge | null> => {
    const [, user] = await Promise.all([
      set(setupClerk$, signal),
      get(clerkUser$),
    ]);
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
export const setupAuthenticatedRealtime$ = command(
  ({ set }, signal: AbortSignal): void => {
    detach(
      (async (ownerSignal: AbortSignal): Promise<void> => {
        const initialization = set(
          initializeAuthenticatedRealtime$,
          ownerSignal,
        );
        // Claim the catalog's readiness before authentication or bridge setup can
        // settle, so startup failures remain visible to its consumers.
        const templates = set(
          subscribePresentationTemplatesChanged$,
          initialization,
          ownerSignal,
        );
        await Promise.all([
          templates,
          set(runAppRealtimeDaemons$, initialization, ownerSignal),
        ]);
      })(signal),
      Reason.Daemon,
      "authenticated daemons",
    );
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
    await set(initializeChatThreadEventSource$, signal);
    signal.throwIfAborted();
    set(setupChatSyncRecovery$, signal);
  },
);
