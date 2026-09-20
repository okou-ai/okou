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
  PlatformConnectorCatalogStatusItem,
} from "../../connector-domain.ts";
import { reloadConnectorAccountSummaries$ } from "../connector-accounts.ts";
import {
  connectorAccountDeletionImpact$,
  readConnectorAccount$,
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
  connector: PlatformConnectorCatalogStatusItem | undefined,
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
  readonly account: ConnectorAccountConnection;
  readonly displayName: string;
}

const internalConnectorAccountRenameDraft$ =
  state<ConnectorAccountRenameDraft | null>(null);
const internalConnectorAccountManagerDraftGeneration$ = state(0);

export const connectorAccountRenameDraft$ = computed((get) => {
  return get(internalConnectorAccountRenameDraft$);
});

export const startConnectorAccountRename$ = command(
  ({ set }, account: ConnectorAccountConnection) => {
    set(internalConnectorAccountManagerDraftGeneration$, (generation) => {
      return generation + 1;
    });
    set(internalConnectorAccountDeletionDraft$, null);
    set(internalConnectorAccountRenameDraft$, {
      account,
      displayName: account.displayName ?? "",
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

export const clearConnectorAccountRename$ = command(({ set }) => {
  set(internalConnectorAccountRenameDraft$, null);
});

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
