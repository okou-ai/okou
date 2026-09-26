import { command, computed, state } from "ccstate";
import { withConnectorConnectionProgress } from "../../connector-connection-progress.ts";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAuthMethodId } from "@okouai/api-contracts/contracts/connector-identity";
import type {
  ConnectorAccountConnection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";

import type {
  PlatformConnectorAccountMutationIntent,
  PlatformConnectorCatalogConnectItem,
  PlatformConnectorCatalogStatusItem,
} from "../../connector-domain.ts";
import {
  connectorAccountSummaryByTarget$,
  connectorAccountTargetKey,
  reloadConnectorAccountSummaries$,
} from "../connector-accounts.ts";
import { onRef, onRejection, resetSignal } from "../../utils.ts";
import {
  connectorAccountDeletionImpact$,
  readConnectorAccount$,
  renameConnectorAccount$,
  settingsConnectorAccounts,
} from "./connector-accounts.ts";
import { resetBuiltinManualGrantForm$ } from "./connectors.ts";

export type ConnectorAccountConnectMode =
  | { readonly kind: "add" }
  | {
      readonly kind: "reconnect";
      readonly connectionId: string;
      readonly authMethod?: ConnectorAuthMethodId;
    };

export interface ConnectorAccountMutationOptions {
  readonly account: PlatformConnectorAccountMutationIntent;
  readonly useDefaultConnectorProjection?: true;
}

export interface DefaultConnectorAccountMutationOptions {
  readonly account: PlatformConnectorAccountMutationIntent;
  readonly useDefaultConnectorProjection: true;
}

export function defaultBuiltinConnectorAccountOptions(
  connector: PlatformConnectorCatalogConnectItem | undefined,
): DefaultConnectorAccountMutationOptions | null {
  if (!connector) {
    return null;
  }
  const connection = connector.connection;
  if (!connection) {
    return connector.connected
      ? null
      : {
          account: { intent: "add" },
          useDefaultConnectorProjection: true,
        };
  }
  return connection.id
    ? {
        account: { intent: "reconnect", connectionId: connection.id },
        useDefaultConnectorProjection: true,
      }
    : null;
}

export function defaultCustomConnectorAccountOptions(
  connector: CustomConnectorResponse | undefined,
): DefaultConnectorAccountMutationOptions | null {
  if (!connector) {
    return null;
  }
  if (!connector.connected) {
    return {
      account: { intent: "add" },
      useDefaultConnectorProjection: true,
    };
  }
  return connector.connectedAccountId
    ? {
        account: {
          intent: "reconnect",
          connectionId: connector.connectedAccountId,
        },
        useDefaultConnectorProjection: true,
      }
    : null;
}

interface BuiltinAccountConnectDialog {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly mode: ConnectorAccountConnectMode;
}

interface CustomAccountConnectDialog {
  readonly connector: CustomConnectorResponse;
  readonly mode: ConnectorAccountConnectMode;
}

const internalBuiltinAccountManager$ =
  state<PlatformConnectorCatalogStatusItem | null>(null);
const internalBuiltinAccountConnectDialog$ =
  state<BuiltinAccountConnectDialog | null>(null);
const internalCustomAccountManager$ = state<CustomConnectorResponse | null>(
  null,
);
const internalCustomAccountConnectDialog$ =
  state<CustomAccountConnectDialog | null>(null);

export const builtinAccountManager$ = computed((get) => {
  return get(internalBuiltinAccountManager$);
});

export const builtinAccountConnectDialog$ = computed((get) => {
  return get(internalBuiltinAccountConnectDialog$);
});

export const customAccountManager$ = computed((get) => {
  return get(internalCustomAccountManager$);
});

export const customAccountConnectDialog$ = computed((get) => {
  return get(internalCustomAccountConnectDialog$);
});

export const openBuiltinAccountManager$ = command(
  (
    { set },
    connector: PlatformConnectorCatalogStatusItem,
    signal: AbortSignal,
  ) => {
    set(internalBuiltinAccountManager$, connector);
    set(internalBuiltinAccountConnectDialog$, null);
    set(
      settingsConnectorAccounts.setTarget$,
      {
        kind: "builtin",
        connectorSlug: connector.slug,
      },
      signal,
    );
  },
);

export const closeBuiltinAccountManager$ = command(({ set }) => {
  set(internalBuiltinAccountManager$, null);
  set(settingsConnectorAccounts.clearTarget$);
});

export const openBuiltinAccountConnectDialog$ = command(
  (
    { set },
    connector: PlatformConnectorCatalogStatusItem,
    mode: ConnectorAccountConnectMode,
  ) => {
    set(resetBuiltinManualGrantForm$, connector.slug);
    set(internalBuiltinAccountManager$, null);
    set(settingsConnectorAccounts.clearTarget$);
    set(internalBuiltinAccountConnectDialog$, { connector, mode });
  },
);

export const closeBuiltinAccountConnectDialog$ = command(({ set }) => {
  set(internalBuiltinAccountConnectDialog$, null);
});

export const openCustomAccountManager$ = command(
  ({ set }, connector: CustomConnectorResponse, signal: AbortSignal) => {
    set(internalCustomAccountManager$, connector);
    set(internalCustomAccountConnectDialog$, null);
    set(
      settingsConnectorAccounts.setTarget$,
      {
        kind: "custom",
        customConnectorId: connector.id,
      },
      signal,
    );
  },
);

export const closeCustomAccountManager$ = command(({ set }) => {
  set(internalCustomAccountManager$, null);
  set(settingsConnectorAccounts.clearTarget$);
});

export const openCustomAccountConnectDialog$ = command(
  (
    { set },
    connector: CustomConnectorResponse,
    mode: ConnectorAccountConnectMode,
  ) => {
    set(internalCustomAccountManager$, null);
    set(settingsConnectorAccounts.clearTarget$);
    set(internalCustomAccountConnectDialog$, { connector, mode });
  },
);

export const closeCustomAccountConnectDialog$ = command(({ set }) => {
  set(internalCustomAccountConnectDialog$, null);
});

interface ConnectorAccountNamePrompt {
  readonly target: ConnectorAccountTarget;
  readonly account: ConnectorAccountConnection;
  readonly connectorLabel: string;
}

const internalConnectorAccountNamePrompt$ =
  state<ConnectorAccountNamePrompt | null>(null);
const internalConnectorAccountNamePromptValue$ = state("");

export const connectorAccountNamePrompt$ = computed((get) => {
  return get(internalConnectorAccountNamePrompt$);
});

export const connectorAccountNamePromptValue$ = computed((get) => {
  return get(internalConnectorAccountNamePromptValue$);
});

export const setConnectorAccountNamePromptValue$ = command(
  ({ set }, value: string) => {
    set(internalConnectorAccountNamePromptValue$, value);
  },
);

export const closeConnectorAccountNamePrompt$ = command(({ set }) => {
  set(internalConnectorAccountNamePrompt$, null);
  set(internalConnectorAccountNamePromptValue$, "");
});

const finishConnectorAccountConnectionCommand$ = command(
  async (
    { set },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string | null;
      readonly connectorLabel: string;
      readonly mode: ConnectorAccountConnectMode;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    set(reloadConnectorAccountSummaries$);
    if (args.mode.kind !== "add" || !args.connectionId) {
      return;
    }
    const account = await set(
      readConnectorAccount$,
      { target: args.target, connectionId: args.connectionId },
      signal,
    );
    signal.throwIfAborted();
    set(internalConnectorAccountNamePromptValue$, "");
    set(internalConnectorAccountNamePrompt$, {
      target: args.target,
      account,
      connectorLabel: args.connectorLabel,
    });
  },
);

export const finishConnectorAccountConnection$ =
  withConnectorConnectionProgress(finishConnectorAccountConnectionCommand$);

interface ConnectorAccountRenameDraft {
  readonly phase: "closing-menu" | "editing";
  readonly account: ConnectorAccountConnection;
  readonly displayName: string;
}

const internalConnectorAccountRenameDraft$ =
  state<ConnectorAccountRenameDraft | null>(null);
const internalConnectorAccountManagerDraftGeneration$ = state(0);
const resetConnectorAccountRenameSave$ = resetSignal();
const internalAccountManagerElement$ = state<HTMLDivElement | null>(null);
const internalAccountRenameInput$ = state<HTMLInputElement | null>(null);
const internalAccountActionsFocus$ = state<string | null>(null);

export const connectorAccountManagerRef$ = onRef(
  command(({ set }, element: HTMLDivElement, signal: AbortSignal) => {
    set(internalAccountManagerElement$, element);
    signal.addEventListener("abort", () => {
      set(internalAccountManagerElement$, null);
      set(resetConnectorAccountManagerDrafts$);
    });
  }),
);

export const connectorAccountRenameInputRef$ = onRef(
  command(({ set }, element: HTMLInputElement, signal: AbortSignal) => {
    set(internalAccountRenameInput$, element);
    element.focus();
    signal.addEventListener("abort", () => {
      set(internalAccountRenameInput$, null);
    });
  }),
);

export const connectorAccountActionsRef$ = onRef(
  command(({ get, set }, element: HTMLButtonElement, _signal: AbortSignal) => {
    if (element.dataset.connectionId === get(internalAccountActionsFocus$)) {
      set(internalAccountActionsFocus$, null);
      element.focus();
    }
  }),
);

export const connectorAccountRenameDraft$ = computed((get) => {
  return get(internalConnectorAccountRenameDraft$);
});

export const startConnectorAccountRename$ = command(
  ({ set }, account: ConnectorAccountConnection) => {
    set(resetConnectorAccountRenameSave$);
    set(internalAccountActionsFocus$, null);
    set(internalConnectorAccountManagerDraftGeneration$, (generation) => {
      return generation + 1;
    });
    set(internalConnectorAccountDeletionDraft$, null);
    set(internalConnectorAccountRenameDraft$, {
      phase: "closing-menu",
      account,
      displayName: account.displayName ?? "",
    });
  },
);

// Let Base UI finish closing the menu before replacing its trigger and popup.
export const completeConnectorAccountRenameMenu$ = command(
  ({ set }, connectionId: string) => {
    set(internalConnectorAccountRenameDraft$, (draft) => {
      return draft?.account.id === connectionId &&
        draft.phase === "closing-menu"
        ? { ...draft, phase: "editing" as const }
        : draft;
    });
  },
);

export const setConnectorAccountRenameValue$ = command(
  ({ set }, displayName: string) => {
    set(internalConnectorAccountRenameDraft$, (draft) => {
      return draft ? { ...draft, displayName } : null;
    });
  },
);

const finishConnectorAccountRename$ = command(
  ({ get, set }, restoreAccount: boolean) => {
    const draft = get(internalConnectorAccountRenameDraft$);
    const manager = get(internalAccountManagerElement$);
    if (!draft || !manager) {
      return;
    }
    // A filtered-out or no-longer-loaded row cannot receive focus. Keep a
    // stable destination inside the manager while React commits the new rows.
    const search = manager.querySelector<HTMLInputElement>(
      "[data-account-search]",
    );
    (search ?? manager).focus();
    set(internalAccountActionsFocus$, restoreAccount ? draft.account.id : null);
    set(internalConnectorAccountRenameDraft$, null);
  },
);

export const clearConnectorAccountRename$ = command(
  ({ set }, restoreAccount: boolean) => {
    set(resetConnectorAccountRenameSave$);
    set(finishConnectorAccountRename$, restoreAccount);
  },
);

const saveConnectorAccountRenameCommand$ = command(
  async ({ get, set }, target: ConnectorAccountTarget, signal: AbortSignal) => {
    const draft = get(internalConnectorAccountRenameDraft$);
    if (!draft) {
      return;
    }
    await set(
      renameConnectorAccount$,
      {
        target,
        connectionId: draft.account.id,
        displayName: draft.displayName.trim() || null,
      },
      signal,
    );
    signal.throwIfAborted();
    while (true) {
      const accountsPromise = get(settingsConnectorAccounts.accounts$);
      const summariesPromise = get(connectorAccountSummaryByTarget$);
      const [accounts, summaries] = await Promise.all([
        accountsPromise,
        summariesPromise,
      ]);
      signal.throwIfAborted();
      // Search or pagination may change while the mutation refresh is pending.
      // Only the currently rendered query can determine the return destination.
      if (
        accountsPromise !== get(settingsConnectorAccounts.accounts$) ||
        summariesPromise !== get(connectorAccountSummaryByTarget$)
      ) {
        continue;
      }
      const pinnedDefault =
        !get(settingsConnectorAccounts.search$).trim() &&
        (accounts.defaultConnection !== undefined
          ? accounts.defaultConnection
          : summaries.get(connectorAccountTargetKey(target))
              ?.defaultConnection);
      const restoreAccount =
        accounts.available &&
        ((pinnedDefault && pinnedDefault.id === draft.account.id) ||
          accounts.connections.some((account) => {
            return account.id === draft.account.id;
          }));
      set(finishConnectorAccountRename$, Boolean(restoreAccount));
      return;
    }
  },
);

export const saveConnectorAccountRename$ = command(
  ({ get, set }, target: ConnectorAccountTarget, pageSignal: AbortSignal) => {
    const signal = set(resetConnectorAccountRenameSave$, pageSignal);
    return onRejection(
      set(saveConnectorAccountRenameCommand$, target, signal),
      () => {
        if (!signal.aborted) {
          get(internalAccountRenameInput$)?.focus();
        }
      },
    );
  },
);

interface ConnectorAccountDeletionDraft {
  readonly account: ConnectorAccountConnection;
  readonly explicitSelectionCount: number;
}

const internalConnectorAccountDeletionDraft$ =
  state<ConnectorAccountDeletionDraft | null>(null);

export const connectorAccountDeletionDraft$ = computed((get) => {
  return get(internalConnectorAccountDeletionDraft$);
});

export const prepareConnectorAccountDeletion$ = command(
  async (
    { get, set },
    args: {
      readonly target: ConnectorAccountConnection["target"];
      readonly account: ConnectorAccountConnection;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const generation = get(internalConnectorAccountManagerDraftGeneration$) + 1;
    set(internalConnectorAccountManagerDraftGeneration$, generation);
    set(internalConnectorAccountRenameDraft$, null);
    set(internalConnectorAccountDeletionDraft$, null);
    const impact = await set(
      connectorAccountDeletionImpact$,
      { target: args.target, connectionId: args.account.id },
      signal,
    );
    signal.throwIfAborted();
    if (get(internalConnectorAccountManagerDraftGeneration$) !== generation) {
      return;
    }
    set(internalConnectorAccountDeletionDraft$, {
      account: args.account,
      explicitSelectionCount: impact.explicitSelectionCount,
    });
  },
);

export const clearConnectorAccountDeletion$ = command(({ set }) => {
  set(internalConnectorAccountDeletionDraft$, null);
});

export const resetConnectorAccountManagerDrafts$ = command(({ set }) => {
  set(resetConnectorAccountRenameSave$);
  set(internalAccountActionsFocus$, null);
  set(internalConnectorAccountManagerDraftGeneration$, (generation) => {
    return generation + 1;
  });
  set(internalConnectorAccountRenameDraft$, null);
  set(internalConnectorAccountDeletionDraft$, null);
});

export const resetConnectorAccountDialogs$ = command(({ set }) => {
  set(internalBuiltinAccountManager$, null);
  set(internalBuiltinAccountConnectDialog$, null);
  set(internalCustomAccountManager$, null);
  set(internalCustomAccountConnectDialog$, null);
  set(internalConnectorAccountNamePrompt$, null);
  set(internalConnectorAccountNamePromptValue$, "");
  set(resetConnectorAccountManagerDrafts$);
  set(settingsConnectorAccounts.clearTarget$);
});
