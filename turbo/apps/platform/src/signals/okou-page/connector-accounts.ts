import { command, computed, state, type Computed } from "ccstate";
import { delay } from "signal-timers";
import {
  connectorAccountTargetKey,
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountSummary,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";

import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { onRejection } from "../utils.ts";

const CONNECTOR_ACCOUNT_PAGE_SIZE = 50;
/** Keep account search responsive while coalescing normal typing bursts. */
const CONNECTOR_ACCOUNT_SEARCH_DEBOUNCE_MS = 250;
export const CONNECTOR_ACCOUNT_SEARCH_THRESHOLD = 6;

export { connectorAccountTargetKey };

const internalSummariesReload$ = state(0);

const connectorAccountSummaries$ = computed(
  async (get): Promise<readonly ConnectorAccountSummary[]> => {
    get(internalSummariesReload$);
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).summaries(),
      [200],
    );
    return result.body.summaries;
  },
);

export const connectorAccountSummaryByTarget$ = computed(
  async (get): Promise<ReadonlyMap<string, ConnectorAccountSummary>> => {
    const summaries = await get(connectorAccountSummaries$);
    return new Map(
      summaries.map((summary) => {
        return [connectorAccountTargetKey(summary.target), summary];
      }),
    );
  },
);

/**
 * What the Connected segment says about the list behind it: how many have an
 * account, and whether any of them stopped working. The count comes from the
 * account summaries rather than from the catalog response, because that
 * response narrows to whatever is being searched for and this number must not
 * move while someone browses another scope.
 */
export const connectedConnectorsBadge$ = computed(
  async (
    get,
  ): Promise<{ readonly count: number; readonly needsAttention: boolean }> => {
    const summaries = await get(connectorAccountSummaries$);
    // Every kind counts, because the scope this number stands for holds every
    // kind: a custom connector with an account is connected like any other.
    const connected = summaries.filter((summary) => {
      return summary.accountCount > 0;
    });
    return {
      count: connected.length,
      needsAttention: connected.some((summary) => {
        return summary.attentionCount > 0;
      }),
    };
  },
);

export const reloadConnectorAccountSummaries$ = command(({ set }) => {
  set(internalSummariesReload$, (version) => {
    return version + 1;
  });
});

interface ConnectorAccountPage {
  readonly connections: readonly ConnectorAccountConnection[];
  readonly nextCursor: string | null;
  readonly available: boolean;
  readonly defaultConnection?: ConnectorAccountConnection | null;
}

function emptyConnectorAccountPage(): ConnectorAccountPage {
  return { connections: [], nextCursor: null, available: false };
}

export interface ConnectorAccountList {
  readonly connections: readonly ConnectorAccountConnection[];
  readonly nextCursor: string | null;
  readonly available: boolean;
  readonly defaultConnection?: ConnectorAccountConnection | null;
}

function mergeConnectorAccountPages(
  firstPage: ConnectorAccountPage,
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
    available: firstPage.available,
    ...(firstPage.defaultConnection !== undefined
      ? { defaultConnection: firstPage.defaultConnection }
      : {}),
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

async function fetchConnectorAccountPage(args: {
  readonly createClient: ApiClientFactory;
  readonly target: ConnectorAccountTarget;
  readonly search: string;
  readonly cursor?: string;
  readonly includeBuiltinScopeMismatch: boolean;
}): Promise<ConnectorAccountPage> {
  const enriched =
    args.includeBuiltinScopeMismatch && args.target.kind === "builtin";
  const result = await accept(
    args.createClient(connectorAccountsContract).connections({
      query: targetListQuery(args.target, args.search, args.cursor, enriched),
    }),
    [200, 404],
  );
  return result.status === 404
    ? emptyConnectorAccountPage()
    : { ...result.body, available: true };
}

interface ConnectorAccountQuery {
  readonly target: ConnectorAccountTarget;
  readonly search: string;
  readonly debounce: boolean;
}

function createConnectorAccountQuerySignals() {
  const query$ = state<ConnectorAccountQuery | null>(null);
  const search$ = state("");
  const lastPage$ = state<Computed<Promise<ConnectorAccountList>> | null>(null);
  const setTarget$ = command(
    ({ get, set }, target: ConnectorAccountTarget, _signal: AbortSignal) => {
      const current = get(query$);
      if (
        current &&
        connectorAccountTargetKey(current.target) ===
          connectorAccountTargetKey(target)
      ) {
        return;
      }
      set(search$, "");
      set(lastPage$, null);
      set(query$, {
        target,
        search: "",
        debounce: false,
      });
    },
  );
  const clearTarget$ = command(({ set }) => {
    set(query$, null);
    set(search$, "");
    set(lastPage$, null);
  });
  const setSearch$ = command(
    ({ get, set }, search: string, _signal: AbortSignal) => {
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
      set(query$, {
        target: current.target,
        search: normalized,
        debounce: normalized.length > 0,
      });
    },
  );
  const resetSearch$ = command(({ set }) => {
    set(search$, "");
  });
  const reload$ = command(({ get, set }, _signal: AbortSignal) => {
    const current = get(query$);
    if (!current) {
      return;
    }
    set(lastPage$, null);
    set(query$, {
      target: current.target,
      search: get(search$),
      debounce: false,
    });
  });
  return {
    query$,
    lastPage$,
    search$: computed((get) => {
      return get(search$);
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
      await delay(CONNECTOR_ACCOUNT_SEARCH_DEBOUNCE_MS);
      if (get(querySignals.query$) !== query) {
        return emptyConnectorAccountPage();
      }
    }
    return fetchConnectorAccountPage({
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
          fetchConnectorAccountPage({
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
