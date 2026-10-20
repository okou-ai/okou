import { command, computed, state, type Computed } from "ccstate";
import { debounceCommand } from "../command-scheduling.ts";
import {
  connectorAccountTargetKey,
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";

import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { onRejection, resetSignal } from "../utils.ts";
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
  return { ...requireConnectorAccountDefault(result.body), available: true };
}

/** This App ships after the API that supplies the target's canonical default. */
export function requireConnectorAccountDefault<
  T extends { readonly defaultConnection?: ConnectorAccountConnection | null },
>(
  page: T,
): T & { readonly defaultConnection: ConnectorAccountConnection | null } {
  if (page.defaultConnection === undefined) {
    throw new Error(
      "Connector account default information is unavailable. Refresh and try again.",
    );
  }
  return { ...page, defaultConnection: page.defaultConnection };
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
  const lastPage$ = state<Computed<Promise<ConnectorAccountList>> | null>(null);
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
      set(query$, {
        target,
        search: "",
        debounce: false,
        request: accountPageRequest(set(resetQuerySignal$, ownerSignal)),
      });
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
  options: { readonly includeBuiltinScopeMismatch?: true } = {},
) {
  const includeBuiltinScopeMismatch =
    options.includeBuiltinScopeMismatch === true;
  const querySignals = createConnectorAccountQuerySignals();
  const firstPage$ = computed(async (get): Promise<ConnectorAccountList> => {
    const query = get(querySignals.query$);
    if (!query) {
      return emptyConnectorAccountPage();
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
    return await get(get(querySignals.lastPage$) ?? firstPage$);
  });
  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const query = get(querySignals.query$);
      if (!query) {
        return;
      }
      const previousPage$ = get(querySignals.lastPage$) ?? firstPage$;
      const previousPage = await get(previousPage$);
      signal.throwIfAborted();
      if (get(querySignals.query$) !== query) {
        return;
      }
      // Another caller already requested this cursor. Await that same page.
      if ((get(querySignals.lastPage$) ?? firstPage$) !== previousPage$) {
        await get(accounts$);
        signal.throwIfAborted();
        return;
      }
      const cursor = previousPage.nextCursor;
      if (!cursor) {
        return;
      }
      const nextPage$ = computed(async (get): Promise<ConnectorAccountList> => {
        const [previous, page] = await Promise.all([
          get(previousPage$),
          query.request({
            createClient: get(apiClient$),
            target: query.target,
            search: query.search,
            cursor,
            includeBuiltinScopeMismatch,
          }),
        ]);
        return page.available
          ? mergeConnectorAccountPages(previous, [page])
          : page;
      });
      set(querySignals.lastPage$, nextPage$);
      const result = await onRejection(get(nextPage$), () => {
        if (
          get(querySignals.query$) === query &&
          get(querySignals.lastPage$) === nextPage$
        ) {
          set(
            querySignals.lastPage$,
            previousPage$ === firstPage$ ? null : previousPage$,
          );
        }
      });
      signal.throwIfAborted();
      if (get(querySignals.query$) !== query) {
        return;
      }
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
