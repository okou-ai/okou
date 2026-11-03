import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { debounceCommand } from "../command-scheduling.ts";
import { connectorAccountTargetKey } from "@okouai/api-contracts/validators/connector-accounts";
import { connectorAccountsContract } from "@okouai/api-contracts/client/connector-accounts";
import type {
  ConnectorAccountConnection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";

import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { isConnectorChangedPayloadFor } from "../connector-change.ts";
import { resetSignal } from "../utils.ts";
import { userConnectedConnectors$ } from "./connector-overview.ts";

const CONNECTOR_ACCOUNT_PAGE_SIZE = 50;
/** Keep account search responsive while coalescing normal typing bursts. */
const CONNECTOR_ACCOUNT_SEARCH_DEBOUNCE_MS = 250;
export const CONNECTOR_ACCOUNT_SEARCH_THRESHOLD = 6;

export { connectorAccountTargetKey };

/** Saved connector membership only; account facts are loaded for an open target. */
export const connectedConnectorTargetKeys$ = computed(async (get) => {
  const connected = await get(userConnectedConnectors$);
  return new Set([
    ...connected.builtinConnectors.map((connector) => {
      return `builtin:${connector.slug}`;
    }),
    ...connected.customConnectors.map((connector) => {
      return `custom:${connector.id}`;
    }),
  ]);
});

export const connectedConnectorsBadge$ = computed(async (get) => {
  const connected = await get(userConnectedConnectors$);
  return {
    count:
      connected.builtinConnectors.length + connected.customConnectors.length,
  };
});

interface ConnectorAccountPage {
  readonly connections: readonly ConnectorAccountConnection[];
  readonly nextCursor: string | null;
  readonly available: boolean;
  readonly defaultConnection: ConnectorAccountConnection | null;
}

function emptyConnectorAccountPage(): ConnectorAccountPage {
  return {
    connections: [],
    nextCursor: null,
    available: false,
    defaultConnection: null,
  };
}

export interface ConnectorAccountList {
  readonly connections: readonly ConnectorAccountConnection[];
  readonly nextCursor: string | null;
  readonly available: boolean;
  readonly defaultConnection: ConnectorAccountConnection | null;
  readonly hasMultiplePages?: boolean;
}

function mergeConnectorAccountPages(
  firstPage: ConnectorAccountList,
  pages: readonly ConnectorAccountPage[],
): ConnectorAccountList {
  return {
    connections: [
      ...firstPage.connections,
      ...pages.flatMap((page) => {
        return page.connections;
      }),
    ],
    // The newest loaded page owns the cursor, including when it ends the list
    // with a null cursor. Falling back to the first page's cursor there would
    // keep "Load more" alive and re-request the page after the first one.
    nextCursor: (pages.at(-1) ?? firstPage).nextCursor,
    hasMultiplePages:
      firstPage.hasMultiplePages === true || firstPage.nextCursor !== null,
    available: firstPage.available,
    defaultConnection: firstPage.defaultConnection,
  };
}

function targetListQuery(
  target: ConnectorAccountTarget,
  search: string,
  cursor?: string,
  includeBuiltinScopeMismatch = false,
) {
  const page = {
    limit: CONNECTOR_ACCOUNT_PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(cursor ? { cursor } : {}),
  };
  return target.kind === "builtin"
    ? {
        ...page,
        kind: target.kind,
        connectorSlug: target.connectorSlug,
        ...(includeBuiltinScopeMismatch
          ? { includeScopeMismatch: "true" as const }
          : {}),
      }
    : {
        ...page,
        kind: target.kind,
        customConnectorId: target.customConnectorId,
      };
}

interface ConnectorAccountPageRequest {
  readonly createClient: ApiClientFactory;
  readonly target: ConnectorAccountTarget;
  readonly search: string;
  readonly cursor?: string;
  readonly includeBuiltinScopeMismatch: boolean;
}

async function fetchConnectorAccountPage(
  args: ConnectorAccountPageRequest,
  signal: AbortSignal,
): Promise<ConnectorAccountPage> {
  const enriched =
    args.includeBuiltinScopeMismatch && args.target.kind === "builtin";
  const result = await accept(
    args.createClient(connectorAccountsContract).connections({
      query: targetListQuery(args.target, args.search, args.cursor, enriched),
      fetchOptions: { signal },
    }),
    [200, 404],
  );
  if (result.status === 404) {
    return emptyConnectorAccountPage();
  }
  return { ...result.body, available: true };
}

interface ConnectorAccountQuery {
  readonly target: ConnectorAccountTarget;
  readonly search: string;
  readonly debounce: boolean;
  readonly request: (
    args: ConnectorAccountPageRequest,
  ) => Promise<ConnectorAccountPage>;
}

function accountPageRequest(signal: AbortSignal) {
  return (args: ConnectorAccountPageRequest) => {
    return fetchConnectorAccountPage(args, signal);
  };
}

function createConnectorAccountQuerySubscription(
  query$: State<ConnectorAccountQuery | null>,
  reload$: Command<void, [AbortSignal]>,
) {
  const invalidateOnSubscribe$ = command(({ set }, signal: AbortSignal) => {
    set(reload$, signal);
    return false;
  });
  const invalidateFromRealtime$ = command(
    ({ get, set }, payload: unknown, signal: AbortSignal) => {
      const target = get(query$)?.target;
      if (
        target?.kind === "builtin" &&
        isConnectorChangedPayloadFor(payload, target.connectorSlug)
      ) {
        set(reload$, signal);
      }
      return false;
    },
  );
  return command(({ get, set }, signal: AbortSignal) => {
    if (get(query$)?.target.kind === "builtin") {
      set(
        setAblyPayloadLoop$,
        {
          topic: "connector:changed",
          loopCommand$: invalidateFromRealtime$,
          initializeCommand$: invalidateOnSubscribe$,
          options: { runOnSubscribe: true },
        },
        signal,
      );
    }
  });
}

function createConnectorAccountQuerySignals() {
  const query$ = state<ConnectorAccountQuery | null>(null);
  const resetQuerySignal$ = resetSignal();
  const search$ = state("");
  const debouncedSearch$ = state(Promise.resolve(""));
  const resetSearchDebounceSignal$ = resetSignal();
  const readSearch$ = command(({ get }, _signal: AbortSignal) => {
    return get(search$);
  });
  const debounceSearch$ = debounceCommand(
    readSearch$,
    CONNECTOR_ACCOUNT_SEARCH_DEBOUNCE_MS,
  );
  const lastPage$ = state<ConnectorAccountList | null>(null);
  const setTarget$ = command(
    (
      { get, set },
      target: ConnectorAccountTarget,
      ownerSignal: AbortSignal,
    ) => {
      const current = get(query$);
      if (
        current &&
        connectorAccountTargetKey(current.target) ===
          connectorAccountTargetKey(target)
      ) {
        return;
      }
      set(resetSearchDebounceSignal$);
      set(search$, "");
      set(lastPage$, null);
      set(debouncedSearch$, Promise.resolve(""));
      const querySignal = set(resetQuerySignal$, ownerSignal);
      set(query$, {
        target,
        search: "",
        debounce: false,
        request: accountPageRequest(querySignal),
      });
      set(subscribe$, querySignal);
    },
  );
  const clearTarget$ = command(({ set }) => {
    set(resetQuerySignal$);
    set(resetSearchDebounceSignal$);
    set(debouncedSearch$, Promise.resolve(""));
    set(query$, null);
    set(search$, "");
    set(lastPage$, null);
  });
  const setSearch$ = command(
    ({ get, set }, search: string, signal: AbortSignal) => {
      const normalized = search.trimStart();
      if (get(search$) === normalized) {
        return;
      }
      set(search$, normalized);
      const current = get(query$);
      if (!current) {
        return;
      }
      set(lastPage$, null);
      if (normalized.length > 0) {
        const searchSignal = set(resetSearchDebounceSignal$, signal);
        set(debouncedSearch$, set(debounceSearch$, searchSignal));
      } else {
        set(resetSearchDebounceSignal$);
        set(debouncedSearch$, Promise.resolve(""));
      }
      set(query$, {
        target: current.target,
        search: normalized,
        debounce: normalized.length > 0,
        request: current.request,
      });
    },
  );
  const resetSearch$ = command(({ set }) => {
    set(resetSearchDebounceSignal$);
    set(debouncedSearch$, Promise.resolve(""));
    set(search$, "");
  });
  const reload$ = command(({ get, set }, _signal: AbortSignal) => {
    set(resetSearchDebounceSignal$);
    set(debouncedSearch$, Promise.resolve(""));
    const current = get(query$);
    if (!current) {
      return;
    }
    set(lastPage$, null);
    set(query$, {
      target: current.target,
      search: get(search$),
      debounce: false,
      request: current.request,
    });
  });
  const subscribe$ = createConnectorAccountQuerySubscription(query$, reload$);
  return {
    query$,
    lastPage$,
    search$: computed((get) => {
      return get(search$);
    }),
    debouncedSearch$: computed((get) => {
      return get(debouncedSearch$);
    }),
    setTarget$,
    clearTarget$,
    setSearch$,
    resetSearch$,
    reload$,
  };
}

export function createConnectorAccountListSignals(
  options: {
    readonly includeBuiltinScopeMismatch?: true;
    readonly refreshVersion$?: Computed<number>;
  } = {},
) {
  const includeBuiltinScopeMismatch =
    options.includeBuiltinScopeMismatch === true;
  const querySignals = createConnectorAccountQuerySignals();
  const firstPage$ = computed(async (get): Promise<ConnectorAccountList> => {
    const query = get(querySignals.query$);
    if (!query) {
      return emptyConnectorAccountPage();
    }
    if (options.refreshVersion$) {
      get(options.refreshVersion$);
    }
    if (query.debounce) {
      const debouncedSearch = await get(querySignals.debouncedSearch$);
      if (
        get(querySignals.query$) !== query ||
        debouncedSearch !== query.search
      ) {
        return emptyConnectorAccountPage();
      }
    }
    return query.request({
      createClient: get(apiClient$),
      target: query.target,
      search: query.search,
      includeBuiltinScopeMismatch,
    });
  });
  const accounts$ = computed(async (get): Promise<ConnectorAccountList> => {
    return get(querySignals.lastPage$) ?? (await get(firstPage$));
  });
  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const query = get(querySignals.query$);
      if (!query) {
        return;
      }
      const previous = get(querySignals.lastPage$);
      const previousPage = previous ?? (await get(firstPage$));
      signal.throwIfAborted();
      if (get(querySignals.query$) !== query) {
        return;
      }
      const cursor = previousPage.nextCursor;
      if (!cursor) {
        return;
      }
      const page = await query.request({
        createClient: get(apiClient$),
        target: query.target,
        search: query.search,
        cursor,
        includeBuiltinScopeMismatch,
      });
      signal.throwIfAborted();
      if (
        get(querySignals.query$) !== query ||
        get(querySignals.lastPage$) !== previous
      ) {
        return;
      }
      const result = page.available
        ? mergeConnectorAccountPages(previousPage, [page])
        : page;
      set(querySignals.lastPage$, result);
      if (!result.available) {
        set(querySignals.reload$, signal);
        await get(accounts$);
        signal.throwIfAborted();
      }
    },
  );
  return {
    search$: querySignals.search$,
    accounts$,
    setTarget$: querySignals.setTarget$,
    clearTarget$: querySignals.clearTarget$,
    setSearch$: querySignals.setSearch$,
    resetSearch$: querySignals.resetSearch$,
    reload$: querySignals.reload$,
    loadMore$,
  };
}
