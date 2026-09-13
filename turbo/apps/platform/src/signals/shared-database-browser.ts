import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { derivePlatformServiceOrigin } from "@okouai/core/platform-service-origin";
import { command, state } from "ccstate";
import sharedDatabaseWorkerAssetUrl from "virtual:shared-database-worker";

import { CONNECTION_DIAGNOSTICS_PARAM } from "../lib/connection-diagnostics-param.ts";
import {
  flushClientTelemetry,
  recordClientTelemetry,
  startClientTelemetryMeasurement,
} from "../lib/client-telemetry.ts";
import { getCapturedPreviewBypassForTarget } from "../lib/preview-bypass-cookie.ts";
import { VERCEL_PROTECTION_BYPASS_NAME } from "../lib/preview-bypass-name.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabaseTokenProvider,
} from "../shared-database/bridge.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
} from "../shared-database/data-key.ts";
import { MessagePortSharedDatabaseBridge } from "../shared-database/message-port-client.ts";
import type { SharedDatabaseWorkerUnavailableReason } from "../shared-database/protocol.ts";
import { SingleConnectionSharedDatabaseBridge } from "../shared-database/single-connection-client.ts";
import { SharedDatabaseWorkerLoadError } from "../shared-database/worker-load-error.ts";
import { reportSharedWorkerFailure } from "./shared-worker-failure.ts";
import { clerk$, clerkUser$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { readClerkToken, waitForClerkSession } from "./clerk-token.ts";
import { applyChatThreadReadCursorUpdated$ } from "./chat-thread-list-reload.ts";
import { syncActiveChatEvents$ } from "./chat-page/chat-event-signal-registry.ts";
import { syncEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { reportForceUpgradeRequired } from "./force-upgrade.ts";
import {
  installSharedDatabaseBridge$,
  setBridgeConnected$,
  sharedDatabaseBridgeInstalled$,
} from "./shared-database-bridge-state.ts";
import { reloadComputedFromWorker$ } from "./shared-database.ts";
import { createDeferredPromise, onDomEventFn, onRejection } from "./utils.ts";

export interface SharedDatabaseBridgeHost {
  createBridge(
    identity: SharedDatabaseIdentity,
    getToken: SharedDatabaseTokenProvider,
    events: SharedDatabaseBridgeEvents,
    signal: AbortSignal,
    diagnosticsEnabled: boolean,
  ): SharedDatabaseBridge;
}

function handleSharedDatabaseWorkerUnavailable(
  reason: SharedDatabaseWorkerUnavailableReason,
): void {
  if (reason === "force-upgrade-required") {
    reportForceUpgradeRequired();
    return;
  }

  throw new Error(
    "Shared database worker is unavailable after an IndexedDB version change",
  );
}

function createBrowserSharedDatabaseBridge(
  identity: SharedDatabaseIdentity,
  getToken: SharedDatabaseTokenProvider,
  events: SharedDatabaseBridgeEvents,
  signal: AbortSignal,
  diagnosticsEnabled: boolean,
): SharedDatabaseBridge {
  const workerUrl = new URL(sharedDatabaseWorkerAssetUrl, location.href);
  const workerParams = new URLSearchParams({
    userId: identity.userId,
    orgId: identity.orgId,
  });
  const apiBaseUrl = derivePlatformServiceOrigin(location.origin, "api");
  const vercelProtectionBypass = getCapturedPreviewBypassForTarget(apiBaseUrl);
  if (vercelProtectionBypass) {
    workerParams.set(VERCEL_PROTECTION_BYPASS_NAME, vercelProtectionBypass);
  }
  if (diagnosticsEnabled) {
    workerParams.set(CONNECTION_DIAGNOSTICS_PARAM, "1");
  }
  // Preserve Vite's bare `worker_file` query marker. Rebuilding the query with
  // URLSearchParams normalizes it to `worker_file=`, which skips Vite's worker
  // environment bootstrap in development.
  workerUrl.search += `${workerUrl.search ? "&" : "?"}${workerParams.toString()}`;
  const worker = new SharedWorker(workerUrl, {
    // The capture decision is part of the URL, so it has to be part of the
    // name too: a tab that disagrees gets its own Worker instead of a
    // URLMismatchError against the running one.
    name: `okou_${identity.userId}_${identity.orgId}${diagnosticsEnabled ? "_diagnostics" : ""}`,
    type: "module",
  });
  const portBridge = new MessagePortSharedDatabaseBridge(
    worker.port,
    events,
    signal,
    getToken,
  );
  let failureReported = false;
  worker.addEventListener(
    "error",
    onDomEventFn(async (event: ErrorEvent) => {
      // This page owns recovery; do not also propagate the native error.
      event.preventDefault();
      if (failureReported) {
        return;
      }
      failureReported = true;
      const workerError: unknown = event.error;
      reportSharedWorkerFailure();
      recordClientTelemetry(
        startClientTelemetryMeasurement(),
        {
          event_name: "shared_worker.failure",
          phase: "error-event",
          // The full URL contains identity and preview credentials.
          script_path: workerUrl.pathname,
        },
        "error",
      );
      portBridge.fail(new SharedDatabaseWorkerLoadError(workerError));
      // Begin sending before the user refreshes, without delaying recovery.
      await flushClientTelemetry();
    }),
    { signal },
  );
  return portBridge;
}

const sharedDatabaseBridgeHostState$ = state<SharedDatabaseBridgeHost>({
  createBridge: createBrowserSharedDatabaseBridge,
});

const preparedSharedDatabaseBridgeState$ =
  state<SingleConnectionSharedDatabaseBridge | null>(null);

const syncSharedDatabaseInvalidation$ = command(
  async (
    { set },
    dataKey: SharedDatabaseDataKey,
    signal: AbortSignal,
  ): Promise<void> => {
    if (dataKey.kind === "chat-event") {
      await set(syncActiveChatEvents$, dataKey.threadId, signal);
      return;
    }
    await set(syncEventDrivenChatThreads$, signal);
  },
);

export const setSharedDatabaseBridgeHostForTest$ = command(
  ({ set }, host: SharedDatabaseBridgeHost): void => {
    set(sharedDatabaseBridgeHostState$, host);
  },
);

const prepareSharedDatabaseBridge$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<SingleConnectionSharedDatabaseBridge | null> => {
    signal.throwIfAborted();
    const existing = get(preparedSharedDatabaseBridgeState$);
    if (existing) {
      await existing.prepare(signal);
      return existing;
    }
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const session = await waitForClerkSession(clerk, signal);
    signal.throwIfAborted();
    const user = await get(clerkUser$);
    signal.throwIfAborted();
    if (!session || !user || !clerk.organization) {
      return null;
    }
    const identity = {
      userId: user.id,
      orgId: clerk.organization.id,
    };
    const diagnosticsEnabled =
      get(featureSwitch$)[FeatureSwitchKey.OkouDebug] ?? false;
    const bridgeHost = get(sharedDatabaseBridgeHostState$);
    const getToken: SharedDatabaseTokenProvider = (requestSignal) => {
      return readClerkToken(clerk, requestSignal);
    };
    const bridge = new SingleConnectionSharedDatabaseBridge({
      createBridge: (events, connectionSignal) => {
        return bridgeHost.createBridge(
          identity,
          getToken,
          events,
          connectionSignal,
          diagnosticsEnabled,
        );
      },
      events: {
        databaseInvalidated: async (dataKey) => {
          await set(syncSharedDatabaseInvalidation$, dataKey, signal);
        },
        workerUnavailable: (reason) => {
          handleSharedDatabaseWorkerUnavailable(reason);
        },
        computedReloaded: (computedKey) => {
          set(reloadComputedFromWorker$, computedKey);
        },
        chatThreadReadCursorUpdated: (payload) => {
          set(applyChatThreadReadCursorUpdated$, payload);
        },
      },
    });
    set(preparedSharedDatabaseBridgeState$, bridge);
    await bridge.prepare(signal);
    return bridge;
  },
);

type BridgeConnection = ReturnType<typeof createDeferredPromise<void>>;

const connectSharedDatabaseBridge$ = command(
  async (
    { get, set },
    connected: BridgeConnection,
    signal: AbortSignal,
  ): Promise<void> => {
    if (get(sharedDatabaseBridgeInstalled$)) {
      connected.resolve(undefined);
      return;
    }
    const bridge = await set(prepareSharedDatabaseBridge$, signal);
    signal.throwIfAborted();
    if (!bridge) {
      return;
    }
    await set(installSharedDatabaseBridge$, bridge, signal);
    signal.throwIfAborted();
    connected.resolve(undefined);
  },
);

export const setupSharedDatabaseBridge$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const connected = createDeferredPromise<void>(signal);
    set(setBridgeConnected$, connected.promise);
    await onRejection(
      set(connectSharedDatabaseBridge$, connected, signal),
      (error) => {
        if (!connected.settled()) {
          connected.reject(error);
        }
      },
    );
    signal.throwIfAborted();
  },
);
