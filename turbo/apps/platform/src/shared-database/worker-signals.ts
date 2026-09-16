import type { InboundMessage } from "ably";
import { command, computed, state } from "ccstate";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { derivePlatformServiceOrigin } from "@okouai/core/platform-service-origin";

import { resolvePlatformEnvironment } from "../lib/platform-host.ts";
import { CONNECTION_DIAGNOSTICS_PARAM } from "../lib/connection-diagnostics-param.ts";
import { VERCEL_PROTECTION_BYPASS_NAME } from "../lib/preview-bypass-name.ts";
import { apiClient$ } from "../signals/api-client.ts";
import { setApiClientRuntime$ } from "../signals/api-client-runtime.ts";
import { initializeAppVersion$ } from "../signals/app-version.ts";
import { setAuthenticatedIdentity$ } from "../signals/auth-context.ts";
import {
  connectionDiagnostics$,
  setupConnectionDiagnostics$,
  writeConnectionDiagnostic$,
} from "../signals/connection-diagnostics.ts";
import {
  computerUseHosts$,
  reloadComputerUseHosts$,
} from "../signals/external/computer-use-hosts.ts";
import {
  queueData$,
  reloadQueueData$,
} from "../signals/queue-page/queue-signals.ts";
import {
  setWorkerAblyLoop$,
  setWorkerAblyPayloadLoop$,
  setupRealtime$,
} from "../signals/realtime.ts";
import {
  rootSignal$,
  rootVersion$,
  setRootSignal$,
} from "../signals/root-signal.ts";
import { logger } from "../signals/log.ts";
import { setDaemon, settle } from "../signals/utils.ts";
import { throttleCommand } from "../signals/command-scheduling.ts";
import {
  chatThreadIndicators$,
  reloadChatThreadIndicators$,
} from "../signals/chat-page/chat-thread-indicators.ts";
import type { ComputedKey, ComputedValue } from "./computed-key.ts";
import type { SharedDatabaseTokenProvider } from "./bridge.ts";
import {
  sharedDatabaseIdentitySchema,
  type ChatThreadIndicators,
  type SharedDatabaseDataKey,
  type SharedDatabaseIdentity,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import type { SharedDatabaseClientMessage } from "./protocol.ts";
import {
  broadcastSharedDatabaseWorkerMessage$,
  forwardChatThreadReadCursorUpdated$,
  reloadComputedForConnections$,
  reportWorkerUnavailableForConnections$,
  requireConnectionSignal$,
  type ConnectionId,
} from "./worker-context.ts";
import { SharedDatabaseWorkerRuntime } from "./worker-runtime.ts";

const L = logger("SharedDatabaseWorker");

const workerRuntimeState$ = state<SharedDatabaseWorkerRuntime | null>(null);
const workerDaemonsStartedState$ = state(false);
interface BootstrapSharedDatabaseWorkerOptions {
  readonly appVersion: string;
  readonly identity: SharedDatabaseIdentity;
  readonly apiBaseUrl: string;
  readonly getToken: SharedDatabaseTokenProvider;
  readonly oauthApiBaseUrl: string;
  readonly onForceUpgrade: () => void;
  readonly vercelProtectionBypass?: string;
}

function requireRuntime(
  runtime: SharedDatabaseWorkerRuntime | null,
): SharedDatabaseWorkerRuntime {
  if (!runtime) {
    throw new Error("Shared database Worker Store is not bootstrapped");
  }
  return runtime;
}

const CHAT_EVENT_CATCH_UP_THROTTLE_MS = 1000;
const RECENT_CHAT_EVENT_CATCH_UP_THREAD_COUNT = 100;

const executeCatchUpChatEvent$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const runtime = requireRuntime(get(workerRuntimeState$));
    const [indicators, threadEvents] = await Promise.all([
      get(chatThreadIndicators$),
      runtime.query(
        {
          dataKey: { kind: "chat-thread-event" },
          afterSeqId: null,
          consistency: "cache-only",
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();
    const recentThreadIds = replayChatThreadEvents(
      threadEvents.snapshot?.chatThreads ?? [],
      threadEvents.events,
    )
      .sort((left, right) => {
        const sortAt = right.sortAt.localeCompare(left.sortAt);
        return sortAt === 0 ? right.id.localeCompare(left.id) : sortAt;
      })
      .slice(0, RECENT_CHAT_EVENT_CATCH_UP_THREAD_COUNT)
      .map((thread) => {
        return thread.id;
      });
    const threadIds = [
      ...new Set([...Object.keys(indicators.threads), ...recentThreadIds]),
    ];
    const updatedThreadIds = await runtime.catchUpChatEvents(threadIds, signal);
    signal.throwIfAborted();
    for (const threadId of updatedThreadIds) {
      set(broadcastSharedDatabaseWorkerMessage$, {
        type: "invalidate",
        dataKey: { kind: "chat-event", threadId },
      });
    }
  },
);

const catchUpChatEventThrottle$ = computed((get) => {
  get(rootVersion$);
  return throttleCommand(
    executeCatchUpChatEvent$,
    CHAT_EVENT_CATCH_UP_THROTTLE_MS,
  );
});

/** Globally serialize ChatEvent catch-up with leading and trailing throttle. */
const catchUpChatEvent$ = command(({ get, set }): Promise<void> => {
  return set(get(catchUpChatEventThrottle$), get(rootSignal$));
});

/**
 * Indicators carry no ChatEvent data, and every thread reader already falls
 * back to its own catch-up, so warming is a head start rather than a data
 * dependency. A tab reading indicators therefore waits only for their fetch:
 * neither the warming throttle nor a warming failure belongs to this read.
 */
const readWorkerChatThreadIndicators$ = command(
  ({ get }): Promise<ChatThreadIndicators> => {
    return get(chatThreadIndicators$);
  },
);

function isInboundMessage(value: unknown): value is InboundMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (!("name" in value) ||
      value.name === undefined ||
      typeof value.name === "string")
  );
}

export const initializeSharedDatabaseWorker$ = command(
  (
    { get, set },
    options: BootstrapSharedDatabaseWorkerOptions,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(initializeAppVersion$, options.appVersion);
    set(setRootSignal$, signal);
    set(setApiClientRuntime$, {
      getToken: options.getToken,
      apiBaseUrl: options.apiBaseUrl,
      oauthApiBaseUrl: options.oauthApiBaseUrl,
      ...(options.vercelProtectionBypass
        ? { vercelProtectionBypass: options.vercelProtectionBypass }
        : {}),
      onForceUpgrade: options.onForceUpgrade,
    });
    set(setAuthenticatedIdentity$, Promise.resolve(options.identity));
    const runtime = new SharedDatabaseWorkerRuntime(
      {
        identity: options.identity,
        emit: (message) => {
          set(broadcastSharedDatabaseWorkerMessage$, message);
        },
        createContractClient: get(apiClient$),
      },
      signal,
    );
    set(workerRuntimeState$, runtime);
  },
);

function resolveWorkerIdentity(): SharedDatabaseIdentity {
  const params = new URL(location.href).searchParams;
  return sharedDatabaseIdentitySchema.parse({
    userId: params.get("userId"),
    orgId: params.get("orgId"),
  });
}

export const bootstrapWorker$ = command(
  (
    { set },
    getToken: SharedDatabaseTokenProvider,
    signal: AbortSignal,
  ): void => {
    const params = new URL(location.href).searchParams;
    const apiBaseUrl = derivePlatformServiceOrigin(location.origin, "api");
    const vercelProtectionBypass = params.get(VERCEL_PROTECTION_BYPASS_NAME);
    set(setupConnectionDiagnostics$, signal);
    // The tab bakes the capture decision into the Worker URL, so a Worker
    // started for a debugging tab records from its very first event.
    set(writeConnectionDiagnostic$, {
      action: "set-enabled",
      enabled: params.has(CONNECTION_DIAGNOSTICS_PARAM),
    });
    const oauthApiBaseUrl =
      resolvePlatformEnvironment() === "production"
        ? derivePlatformServiceOrigin(location.origin, "www")
        : apiBaseUrl;
    set(
      initializeSharedDatabaseWorker$,
      {
        appVersion: __OKOU_APP_VERSION__,
        identity: resolveWorkerIdentity(),
        apiBaseUrl,
        getToken,
        oauthApiBaseUrl,
        onForceUpgrade: () => {
          set(reportWorkerUnavailableForConnections$, "force-upgrade-required");
        },
        ...(vercelProtectionBypass ? { vercelProtectionBypass } : {}),
      },
      signal,
    );
  },
);

export const handleSharedDatabaseRealtimeMessage$ = command(
  ({ set }, payload: unknown, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    if (!isInboundMessage(payload)) {
      throw new Error("Shared database realtime message is invalid");
    }
    const topic = payload.name ?? "";
    const threadId = topic.startsWith("chatThreadMessageCreated:")
      ? topic.slice("chatThreadMessageCreated:".length)
      : null;
    const dataKey: SharedDatabaseDataKey | null =
      threadId !== null && threadId.length > 0
        ? { kind: "chat-event", threadId }
        : topic === "threadListChanged"
          ? { kind: "chat-thread-event" }
          : null;
    if (dataKey) {
      set(broadcastSharedDatabaseWorkerMessage$, {
        type: "invalidate",
        dataKey,
      });
    }
    return false;
  },
);

const reloadWorkerComputed$ = command(
  ({ set }, computedKey: ComputedKey): void => {
    switch (computedKey) {
      case "chat-thread-indicators": {
        set(reloadChatThreadIndicators$);
        return;
      }
      case "computer-use-hosts": {
        set(reloadComputerUseHosts$);
        return;
      }
      case "connection-diagnostics": {
        // Diagnostics derive from Worker Store state, so there is no fetch to
        // repeat: the next read already observes every recorded event.
        return;
      }
      case "queue-data": {
        set(reloadQueueData$);
        return;
      }
    }
  },
);

/** Recompute one Worker computed and tell every tab to re-read it. */
export const refreshWorkerComputed$ = command(
  ({ set }, computedKey: ComputedKey): void => {
    set(reloadWorkerComputed$, computedKey);
    set(reloadComputedForConnections$, computedKey);
  },
);

const refreshWorkerChatIndicators$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(reloadWorkerComputed$, "chat-thread-indicators");
    await set(readWorkerChatThreadIndicators$);
    signal.throwIfAborted();
  },
);

const reloadWorkerChatIndicatorsFromRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    await set(refreshWorkerChatIndicators$, signal);
    set(reloadComputedForConnections$, "chat-thread-indicators");
    // Notify tabs before optional warming can delay or fail this refresh.
    await set(catchUpChatEvent$);
    signal.throwIfAborted();
    return false;
  },
);

const reloadWorkerChatIndicatorsFromReadCursor$ = command(
  async ({ set }, payload: unknown, signal: AbortSignal): Promise<boolean> => {
    await set(refreshWorkerChatIndicators$, signal);
    set(forwardChatThreadReadCursorUpdated$, payload);
    set(reloadComputedForConnections$, "chat-thread-indicators");
    await set(catchUpChatEvent$);
    signal.throwIfAborted();
    return false;
  },
);

const reloadWorkerComputerUseHostsFromRealtime$ = command(
  ({ set }, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    set(reloadWorkerComputed$, "computer-use-hosts");
    set(reloadComputedForConnections$, "computer-use-hosts");
    return false;
  },
);

const reloadWorkerQueueDataFromRealtime$ = command(
  ({ set }, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    set(reloadWorkerComputed$, "queue-data");
    set(reloadComputedForConnections$, "queue-data");
    return false;
  },
);

const runSharedDatabaseWorkerDaemons$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const setup = await settle(set(setupRealtime$, signal), signal);
    if (!setup.ok) {
      L.warn("shared database realtime setup failed", setup.error);
      return;
    }
    const onError = (error: unknown) => {
      L.warn("shared database realtime subscriptions failed", error);
    };

    set(
      setWorkerAblyPayloadLoop$,
      {
        scope: "credential",
        topic: null,
        loopCommand$: handleSharedDatabaseRealtimeMessage$,
        includeMessage: true,
        options: { onError },
      },
      signal,
    );
    set(
      setWorkerAblyLoop$,
      {
        scope: "credential",
        topic: "threadListChanged",
        loopCommand$: reloadWorkerChatIndicatorsFromRealtime$,
        options: {
          onError,
          runOnSubscribe: true,
        },
      },
      signal,
    );
    set(
      setWorkerAblyPayloadLoop$,
      {
        scope: "credential",
        topic: "chatThreadReadCursorUpdated",
        loopCommand$: reloadWorkerChatIndicatorsFromReadCursor$,
        options: { onError },
      },
      signal,
    );
    set(
      setWorkerAblyLoop$,
      {
        scope: "user",
        topic: "computerUseHostsChanged",
        loopCommand$: reloadWorkerComputerUseHostsFromRealtime$,
        options: {
          onError,
          runOnSubscribe: true,
        },
      },
      signal,
    );
    set(
      setWorkerAblyLoop$,
      {
        scope: "user",
        topic: "billing:changed",
        loopCommand$: reloadWorkerQueueDataFromRealtime$,
        options: {
          onError,
          runOnSubscribe: true,
        },
      },
      signal,
    );
  },
);

export const startSharedDatabaseWorkerDaemons$ = command(
  ({ get, set }): void => {
    if (get(workerDaemonsStartedState$)) {
      return;
    }
    const signal = get(rootSignal$);
    set(workerDaemonsStartedState$, true);
    setDaemon((ownerSignal) => {
      return set(runSharedDatabaseWorkerDaemons$, ownerSignal);
    }, signal);
  },
);

export const querySharedDatabaseWorker$ = command(
  async (
    { get, set },
    connectionId: ConnectionId,
    query: SharedDatabaseQuery<SharedDatabaseDataKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<SharedDatabaseDataKey>> => {
    set(requireConnectionSignal$, connectionId, signal);
    return await requireRuntime(get(workerRuntimeState$)).query(query, signal);
  },
);

type QueryMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "query" }
>;
type GetComputedMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "get-computed" }
>;

export const queryStoreMessage$ = command(
  async (
    { set },
    connectionId: ConnectionId,
    message: QueryMessage,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<SharedDatabaseDataKey>> => {
    return await set(
      querySharedDatabaseWorker$,
      connectionId,
      message.query,
      signal,
    );
  },
);

export const getComputedStoreMessage$ = command(
  async (
    { get, set },
    connectionId: ConnectionId,
    message: GetComputedMessage,
    signal: AbortSignal,
  ): Promise<ComputedValue<ComputedKey>> => {
    set(requireConnectionSignal$, connectionId, signal);
    if (message.computedKey === "connection-diagnostics") {
      return get(connectionDiagnostics$);
    }
    if (message.computedKey === "indexeddb-diagnostics") {
      const diagnostics = await requireRuntime(
        get(workerRuntimeState$),
      ).getIndexedDbDiagnostics(signal);
      signal.throwIfAborted();
      return diagnostics;
    }
    if (message.computedKey === "indexeddb-snapshot-measurement") {
      return await requireRuntime(
        get(workerRuntimeState$),
      ).measureIndexedDbSnapshot(signal);
    }
    const value =
      message.computedKey === "chat-thread-indicators"
        ? await set(readWorkerChatThreadIndicators$)
        : message.computedKey === "computer-use-hosts"
          ? await get(computerUseHosts$)
          : await get(queueData$);
    signal.throwIfAborted();
    return value;
  },
);
