import { command } from "ccstate";
import { clerk$, clerkUser$, setupClerk$ } from "./auth.ts";
import { setupChatDatabaseRealtime$ } from "./chat-database/realtime.ts";
import { chatDatabaseReady$ } from "./chat-database/signals.ts";
import { initializeChatThreadEventSource$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { subscribeCloudflareAccessChanged$ } from "./cloudflare-access.ts";
import { subscribeTailscaleChanged$ } from "./tailscale.ts";
import { setupRunModelRealtime$ } from "./external/run-model-realtime.ts";
import { setupUserPreferenceRealtime$ } from "./external/user-model-preference.ts";
import { setupBillingRealtime$ } from "./okou-page/billing.ts";
import { subscribeCustomTemplatesChanged$ } from "./okou-page/custom-template-library.ts";
import { subscribeForYouSources$ } from "./okou-page/for-you-sources.ts";
import { setupGetStartedRewards$ } from "./okou-page/get-started.ts";
import { subscribePresentationTemplatesChanged$ } from "./okou-page/presentation-template-library.ts";
import { subscribePermissionUpdate$ } from "./permission-allow/permission-allow-signals.ts";
import { hydrateProjectCache$ } from "./projects/projects.ts";
import { setupRealtime$ } from "./realtime.ts";
import { subscribeVncObservations$ } from "./vnc.ts";
import { detach, Reason } from "./utils.ts";

const runAppRealtimeDaemons$ = command(
  async (
    { set },
    initialization: Promise<boolean>,
    signal: AbortSignal,
  ): Promise<void> => {
    const authenticated = await initialization;
    signal.throwIfAborted();
    if (!authenticated) {
      return;
    }
    set(setupGetStartedRewards$, signal);
    set(subscribePermissionUpdate$, signal);
    set(setupBillingRealtime$, signal);
    set(setupUserPreferenceRealtime$, signal);
    set(setupRunModelRealtime$, signal);
    set(subscribeCustomTemplatesChanged$, signal);
    set(subscribeVncObservations$, signal);
    set(subscribeCloudflareAccessChanged$, signal);
    set(subscribeTailscaleChanged$, signal);
  },
);

const initializeAuthenticatedRealtime$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const [, user] = await Promise.all([
      set(setupClerk$, signal),
      get(clerkUser$),
    ]);
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!user || !clerk.organization) {
      return false;
    }

    await get(chatDatabaseReady$);
    signal.throwIfAborted();
    await set(setupRealtime$, signal);
    signal.throwIfAborted();
    set(subscribeForYouSources$, signal);
    return true;
  },
);

/** Run user-scoped application realtime services for the root lifecycle. */
export const setupAuthenticatedRealtime$ = command(
  ({ set }, signal: AbortSignal): void => {
    const initialization = set(initializeAuthenticatedRealtime$, signal);
    // Claim readiness before authentication or realtime setup settles, so
    // startup failures remain visible to consumers.
    const chatDatabaseRealtime = set(
      setupChatDatabaseRealtime$,
      initialization,
      signal,
    );
    const templates = set(
      subscribePresentationTemplatesChanged$,
      initialization,
      signal,
    );
    detach(
      (async (ownerSignal: AbortSignal): Promise<void> => {
        await Promise.all([
          chatDatabaseRealtime,
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
    await get(chatDatabaseReady$);
    signal.throwIfAborted();
    await Promise.all([
      set(initializeChatThreadEventSource$, signal),
      // Restore the sidebar early; its route owns the canonical catch-up.
      set(hydrateProjectCache$, signal),
    ]);
    signal.throwIfAborted();
  },
);
