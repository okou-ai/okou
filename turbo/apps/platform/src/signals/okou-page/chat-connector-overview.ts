import {
  command,
  computed,
  state,
  type State,
  type Computed,
  type Command,
} from "ccstate";
import { chatConnectorAccessContract } from "@okouai/api-contracts/client/chat-connector-access";
import type { ChatConnectorOverviewEntry } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorAccountTargetKey } from "@okouai/api-contracts/validators/connector-accounts";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorChangedPayloadSchema } from "@okouai/api-contracts/validators/realtime";

import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { pageSignal$ } from "../page-signal.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { createDeferredPromise, resetSignal } from "../utils.ts";
import {
  builtinConnectorAccountProjectionVersion$,
  customConnectorAccountProjectionVersion$,
} from "./connector-account-projection.ts";

type Overview = readonly ChatConnectorOverviewEntry[];
function overviewRequests(
  ready: Promise<void>,
  threadId: string | undefined,
  signal: AbortSignal,
) {
  return {
    all: async (client: ApiClientFactory): Promise<Overview> => {
      await ready;
      signal.throwIfAborted();
      const result = await accept(
        client(chatConnectorAccessContract).overview({
          query: threadId ? { threadId } : {},
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      return result.body;
    },
    target: async (
      client: ApiClientFactory,
      target: ConnectorAccountTarget,
    ) => {
      await ready;
      signal.throwIfAborted();
      const result = await accept(
        client(chatConnectorAccessContract).overviewTarget({
          query: { ...target, ...(threadId ? { threadId } : {}) },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      return result.body.connector;
    },
  };
}
interface CacheOwner {
  readonly signal: AbortSignal;
  readonly requests: ReturnType<typeof overviewRequests>;
}
interface CacheEpoch {
  readonly owner: CacheOwner | null;
  readonly version: number;
  readonly builtinVersion: number;
  readonly customVersion: number;
  readonly client: ApiClientFactory;
}
interface TargetPatch {
  readonly epoch: CacheEpoch;
  readonly revision: number;
  readonly value: ChatConnectorOverviewEntry | null | undefined;
}

function createOverviewReads(
  owner$: State<CacheOwner | null>,
  version$: State<number>,
) {
  // Patches retain only generation identity, never earlier whole-list promises.
  const epoch$ = computed((get): CacheEpoch => {
    return {
      owner: get(owner$),
      version: get(version$),
      builtinVersion: get(builtinConnectorAccountProjectionVersion$),
      customVersion: get(customConnectorAccountProjectionVersion$),
      client: get(apiClient$),
    };
  });
  const baseline$ = computed(async (get): Promise<Overview> => {
    const { owner, client } = get(epoch$);
    if (!owner) {
      return [];
    }
    return await owner.requests.all(client);
  });
  return { epoch$, baseline$ };
}

function createTargetRefreshCommand({
  owner$,
  epoch$,
  baseline$,
  patches$,
}: {
  readonly owner$: State<CacheOwner | null>;
  readonly epoch$: Computed<CacheEpoch>;
  readonly baseline$: Computed<Promise<Overview>>;
  readonly patches$: State<ReadonlyMap<string, TargetPatch>>;
}) {
  return command(
    async (
      { get, set },
      target: ConnectorAccountTarget,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const owner = get(owner$);
      if (!owner) {
        return;
      }
      const epoch = get(epoch$);
      const key = connectorAccountTargetKey(target);
      const previous = get(patches$).get(key);
      const revision = (previous?.revision ?? 0) + 1;
      set(patches$, (patches) => {
        return new Map(patches).set(key, {
          epoch,
          revision,
          value: previous?.epoch === epoch ? previous.value : undefined,
        });
      });
      await get(baseline$);
      signal.throwIfAborted();
      if (get(epoch$) !== epoch) {
        return;
      }
      const value = await owner.requests.target(get(apiClient$), target);
      signal.throwIfAborted();
      owner.signal.throwIfAborted();
      if (
        get(epoch$) !== epoch ||
        get(patches$).get(key)?.revision !== revision
      ) {
        return;
      }
      set(patches$, (patches) => {
        return new Map(patches).set(key, {
          epoch,
          revision,
          value,
        });
      });
    },
  );
}

function createNotificationRefreshCommand(
  refreshes$: State<ReadonlyMap<string, Promise<void>>>,
  refreshTarget$: ReturnType<typeof createTargetRefreshCommand>,
  refreshAll$: Command<Promise<boolean>, [AbortSignal]>,
) {
  return command(async ({ set }, payload: unknown, signal: AbortSignal) => {
    const parsed = connectorChangedPayloadSchema.safeParse(payload);
    if (parsed.success) {
      const target = {
        kind: "builtin" as const,
        connectorSlug: parsed.data.connectorSlug,
      };
      const refresh = set(refreshTarget$, target, signal);
      set(refreshes$, (refreshes) => {
        return new Map(refreshes).set(
          connectorAccountTargetKey(target),
          refresh,
        );
      });
      await refresh;
    } else {
      await set(refreshAll$, signal);
    }
    return false;
  });
}

/** One Chat page owns the memoized baseline, target patches and subscription. */
export function createChatConnectorOverviewSignals(threadId?: string) {
  const owner$ = state<CacheOwner | null>(null);
  const notificationRefreshes$ = state<ReadonlyMap<string, Promise<void>>>(
    new Map(),
  );
  const version$ = state(0);
  const patches$ = state<ReadonlyMap<string, TargetPatch>>(new Map());
  const resetOwner$ = resetSignal();
  const { epoch$, baseline$ } = createOverviewReads(owner$, version$);
  const notifications$ = computed(async (get) => {
    await Promise.all(get(notificationRefreshes$).values());
  });
  const entries$ = computed(async (get): Promise<Overview> => {
    const patches = get(patches$);
    const epoch = get(epoch$);
    const entries = await get(baseline$);
    const merged = new Map(
      entries.map((entry) => {
        return [connectorAccountTargetKey(entry.target), entry];
      }),
    );
    for (const [key, patch] of patches) {
      if (patch.epoch !== epoch || patch.value === undefined) {
        continue;
      }
      if (patch.value) {
        merged.set(key, patch.value);
      } else {
        merged.delete(key);
      }
    }
    return [...merged.values()];
  });
  const reload$ = command(({ set }) => {
    set(notificationRefreshes$, new Map());
    set(patches$, new Map());
    set(version$, (version) => {
      return version + 1;
    });
  });
  const refreshAll$ = command(async ({ get, set }, signal: AbortSignal) => {
    set(reload$);
    await get(entries$);
    signal.throwIfAborted();
    return false;
  });
  const refreshTarget$ = createTargetRefreshCommand({
    owner$,
    epoch$,
    baseline$,
    patches$,
  });
  const changed$ = createNotificationRefreshCommand(
    notificationRefreshes$,
    refreshTarget$,
    refreshAll$,
  );
  const open$ = command(({ get, set }, parentSignal: AbortSignal) => {
    if (get(owner$)) {
      return;
    }
    const signal = set(resetOwner$, parentSignal);
    const ready = createDeferredPromise<void>({ rejection: "owner" }, signal);
    const owner = {
      signal,
      requests: overviewRequests(ready.promise, threadId, signal),
    };
    set(notificationRefreshes$, new Map());
    set(owner$, owner);
    // Custom account writes do not all publish connector:changed notifications.
    window.addEventListener(
      "focus",
      () => {
        if (!document.hidden) {
          set(reload$);
        }
      },
      { signal },
    );
    signal.addEventListener(
      "abort",
      () => {
        if (get(owner$) === owner) {
          set(owner$, null);
          set(patches$, new Map());
          set(notificationRefreshes$, new Map());
        }
      },
      { once: true },
    );
    set(
      setAblyPayloadLoop$,
      {
        topic: "connector:changed",
        loopCommand$: changed$,
        initializeCommand$: refreshAll$,
        options: {
          runOnSubscribe: false,
          onSubscribed: () => {
            return ready.resolve();
          },
          onError: (error: unknown) => {
            if (!ready.settled()) {
              ready.reject(error);
            } else {
              throw error;
            }
          },
        },
      },
      signal,
    );
  });
  const retry$ = command(({ get, set }) => {
    set(resetOwner$);
    set(open$, get(pageSignal$));
  });
  return { entries$, notifications$, open$, reload$, refreshTarget$, retry$ };
}
