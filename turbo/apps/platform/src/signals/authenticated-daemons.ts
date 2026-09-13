import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { clerk$, clerkUser$, setupClerk$ } from "./auth.ts";
import { setAuthenticatedIdentity$ } from "./auth-context.ts";
import { subscribeEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { setupUserPreferenceRealtime$ } from "./external/user-model-preference.ts";
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

const runAppRealtimeDaemons$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    await get(bridgeConnected$);
    signal.throwIfAborted();
    set(setSharedWorkerRealtimeBridge$, get(installedSharedDatabaseBridge$));
    await set(setupRealtime$, signal);
    signal.throwIfAborted();
    await Promise.all([
      set(subscribePermissionUpdate$, signal),
      set(setupBillingRealtime$, signal),
      set(subscribePresentationTemplatesChanged$, signal),
      set(setupUserPreferenceRealtime$, signal),
      set(setupMorningBriefRealtime$, signal),
      set(subscribeCustomConnectorListChanged$, signal),
      set(subscribeSshChanged$, signal),
    ]);
  },
);

/** Run user-scoped application realtime services for the root lifecycle. */
export const runAuthenticatedRealtime$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    await set(setupClerk$, signal);
    const user = await get(clerkUser$);
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!user || !clerk.organization) {
      return;
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

    await set(runAppRealtimeDaemons$, signal);
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
      set(subscribeEventDrivenChatThreads$, signal),
      set(initializeUserTimezone$, signal),
    ]);
  },
);
