import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
  ConnectorAccountSummary,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { resetSignal, withCleanup } from "../utils.ts";
import {
  connectorAccountSummaryByTarget$,
  connectorAccountTargetKey,
  createConnectorAccountListSignals,
  reloadConnectorAccountSummaries$,
} from "./connector-accounts.ts";

export interface ComposerConnectorAccountPreferenceState {
  readonly selections: readonly ConnectorAccountSelection[];
  readonly selectedConnections: readonly ConnectorAccountConnection[];
}

export interface ComposerConnectorAccountSignals {
  readonly preferenceState$: Computed<
    Promise<ComposerConnectorAccountPreferenceState>
  >;
  readonly summaryByTarget$: Computed<
    Promise<ReadonlyMap<string, ConnectorAccountSummary>>
  >;
  readonly menuTarget$: Computed<ConnectorAccountTarget | null>;
  readonly menuOpen$: Computed<boolean>;
  readonly search$: Computed<string>;
  readonly accounts$: ReturnType<
    typeof createConnectorAccountListSignals
  >["accounts$"];
  readonly openTarget$: Command<void, [ConnectorAccountTarget, AbortSignal]>;
  readonly closeMenu$: Command<void, []>;
  readonly setSearch$: ReturnType<
    typeof createConnectorAccountListSignals
  >["setSearch$"];
  readonly loadMore$: ReturnType<
    typeof createConnectorAccountListSignals
  >["loadMore$"];
  readonly saving$: Computed<boolean>;
  readonly commitSelection$: Command<
    Promise<void>,
    [ConnectorAccountConnection | null, AbortSignal]
  >;
  readonly reloadPreference$: Command<void, []>;
  readonly reload$: Command<void, []>;
  readonly openPopover$: Command<void, []>;
  readonly resetPendingSelections$: Command<void, []>;
}

function emptyPreferenceState(): ComposerConnectorAccountPreferenceState {
  return { selections: [], selectedConnections: [] };
}

function selectionForConnection(
  connection: ConnectorAccountConnection,
): ConnectorAccountSelection {
  return { connectionId: connection.id, target: connection.target };
}

function createConnectorAccountMutationSignals(args: {
  readonly threadId: string | undefined;
  readonly pendingState$: State<ComposerConnectorAccountPreferenceState>;
  readonly preferenceState$: ComposerConnectorAccountSignals["preferenceState$"];
  readonly reload$: Command<void, []>;
}) {
  const selectAccount$ = command(
    async (
      { get, set },
      connection: ConnectorAccountConnection,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const targetKey = connectorAccountTargetKey(connection.target);
      if (!args.threadId) {
        const current = get(args.pendingState$);
        const selection = selectionForConnection(connection);
        set(args.pendingState$, {
          selections: [
            ...current.selections.filter((candidate) => {
              return connectorAccountTargetKey(candidate.target) !== targetKey;
            }),
            selection,
          ],
          selectedConnections: [
            ...current.selectedConnections.filter((candidate) => {
              return connectorAccountTargetKey(candidate.target) !== targetKey;
            }),
            connection,
          ],
        });
        return;
      }
      await accept(
        get(apiClient$)(chatThreadConnectorSelectionContract).update({
          params: { id: args.threadId },
          body: selectionForConnection(connection),
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      set(args.reload$);
      await get(args.preferenceState$);
      signal.throwIfAborted();
    },
  );

  const useDefault$ = command(
    async (
      { get, set },
      target: ConnectorAccountTarget,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const targetKey = connectorAccountTargetKey(target);
      if (!args.threadId) {
        const current = get(args.pendingState$);
        set(args.pendingState$, {
          selections: current.selections.filter((candidate) => {
            return connectorAccountTargetKey(candidate.target) !== targetKey;
          }),
          selectedConnections: current.selectedConnections.filter(
            (candidate) => {
              return connectorAccountTargetKey(candidate.target) !== targetKey;
            },
          ),
        });
        return;
      }
      await accept(
        get(apiClient$)(chatThreadConnectorSelectionContract).clear({
          params: { id: args.threadId },
          body: target,
          fetchOptions: { signal },
        }),
        [204, 404],
        signal,
      );
      signal.throwIfAborted();
      set(args.reload$);
      await get(args.preferenceState$);
      signal.throwIfAborted();
    },
  );

  return { selectAccount$, useDefault$ };
}

export function createComposerConnectorAccountSignals(
  threadId?: string,
): ComposerConnectorAccountSignals {
  const list = createConnectorAccountListSignals();
  const menuTarget$ = state<ConnectorAccountTarget | null>(null);
  const menuOpen$ = state(false);
  const activeSave$ = state<Promise<void> | null>(null);
  const resetSaveSignal$ = resetSignal();
  const reloadVersion$ = state(0);
  const pendingState$ = state<ComposerConnectorAccountPreferenceState>(
    emptyPreferenceState(),
  );
  const preferenceState$ = computed(
    async (get): Promise<ComposerConnectorAccountPreferenceState> => {
      if (!threadId) {
        return get(pendingState$);
      }
      get(reloadVersion$);
      const result = await accept(
        get(apiClient$)(chatThreadConnectorSelectionContract).get({
          params: { id: threadId },
        }),
        [200, 404],
      );
      return result.status === 404 ? emptyPreferenceState() : result.body;
    },
  );

  const reloadPreference$ = command(({ set }) => {
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });
  const reload$ = command(({ set }) => {
    set(reloadPreference$);
    set(reloadConnectorAccountSummaries$);
  });
  const openPopover$ = command(({ set }) => {
    set(reload$);
  });
  const openTarget$ = command(
    (
      { get, set },
      target: ConnectorAccountTarget,
      signal: AbortSignal,
    ): void => {
      const currentTarget = get(menuTarget$);
      set(resetSaveSignal$);
      set(activeSave$, null);
      // A dismissed write may have reached the server before cancellation.
      set(reloadPreference$);
      set(menuTarget$, target);
      if (
        currentTarget &&
        connectorAccountTargetKey(currentTarget) ===
          connectorAccountTargetKey(target)
      ) {
        set(list.reload$, signal);
      } else {
        set(list.setTarget$, target, signal);
      }
      set(menuOpen$, true);
    },
  );
  const closeMenu$ = command(({ set }): void => {
    set(resetSaveSignal$);
    set(activeSave$, null);
    set(menuOpen$, false);
    set(list.resetSearch$);
  });

  const mutations = createConnectorAccountMutationSignals({
    threadId,
    pendingState$,
    preferenceState$,
    reload$: reloadPreference$,
  });

  const commitSelection$ = command(
    async (
      { get, set },
      connection: ConnectorAccountConnection | null,
      parentSignal: AbortSignal,
    ): Promise<void> => {
      const target = get(menuTarget$);
      if (!get(menuOpen$) || !target || get(activeSave$)) {
        return;
      }
      const signal = set(resetSaveSignal$, parentSignal);
      const pending = connection
        ? set(mutations.selectAccount$, connection, signal)
        : set(mutations.useDefault$, target, signal);
      set(activeSave$, pending);
      await withCleanup(pending, () => {
        // A dismissed request must not reset a newer menu session's save.
        if (get(activeSave$) === pending) {
          set(activeSave$, null);
        }
      });
      signal.throwIfAborted();
      set(closeMenu$);
    },
  );

  const resetPendingSelections$ = command(({ set }) => {
    if (!threadId) {
      set(pendingState$, emptyPreferenceState());
    }
  });

  return {
    preferenceState$,
    summaryByTarget$: connectorAccountSummaryByTarget$,
    menuTarget$: computed((get) => {
      return get(menuTarget$);
    }),
    menuOpen$: computed((get) => {
      return get(menuOpen$);
    }),
    search$: list.search$,
    accounts$: list.accounts$,
    openTarget$,
    closeMenu$,
    setSearch$: list.setSearch$,
    loadMore$: list.loadMore$,
    saving$: computed((get) => {
      return get(activeSave$) !== null;
    }),
    commitSelection$,
    reloadPreference$,
    reload$,
    openPopover$,
    resetPendingSelections$,
  };
}
