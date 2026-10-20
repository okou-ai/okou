import { command } from "ccstate";
import { onRef } from "../../utils.ts";
import { reloadUserConnectedConnectors$ } from "../connector-overview.ts";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";

import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import type { PlatformConnectorAccountMutationIntent } from "../../connector-domain.ts";
import type { CustomConnectorAccountMutationIntent } from "./connector-account-dialogs.ts";
import {
  connectorAccountTargetKey,
  createConnectorAccountListSignals,
} from "../connector-accounts.ts";

/** Read one target only when an account surface or mutation needs its facts. */
export async function readConnectorAccountPage(
  createClient: ApiClientFactory,
  target: ConnectorAccountTarget,
  signal: AbortSignal,
) {
  const result = await accept(
    createClient(connectorAccountsContract).connections({
      query: { ...target, limit: 50 },
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  return result.body;
}

export async function readConnectorAccountCount(
  createClient: ApiClientFactory,
  target: ConnectorAccountTarget,
  signal: AbortSignal,
): Promise<number> {
  const page = await readConnectorAccountPage(createClient, target, signal);
  return page.connections.length;
}

/** Completion requires facts for the operated account, including on old API responses. */
export async function readConnectorAccountCompletion(
  createClient: ApiClientFactory,
  target: ConnectorAccountTarget,
  connectionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await accept(
    createClient(connectorAccountsContract).connection({
      params: { connectionId },
      query: target,
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  signal.throwIfAborted();
  if (
    result.body.id !== connectionId ||
    connectorAccountTargetKey(result.body.target) !==
      connectorAccountTargetKey(target) ||
    result.body.setupStatus === undefined
  ) {
    throw new Error(
      "Connector account setup information is unavailable. Refresh and try again.",
    );
  }
  if (result.body.setupStatus !== "complete") {
    throw new Error(
      "This account needs additional setup. Review its connector settings and try again.",
    );
  }
  return result.body.connectionStatus === "connected";
}

export async function resolveCustomConnectorAccountMutation(
  createClient: ApiClientFactory,
  customConnectorId: string,
  account: CustomConnectorAccountMutationIntent,
  signal: AbortSignal,
): Promise<ConnectorAccountMutationIntent> {
  if (account.intent !== "default") {
    return account;
  }
  const page = await readConnectorAccountPage(
    createClient,
    { kind: "custom", customConnectorId },
    signal,
  );
  signal.throwIfAborted();
  if (page.defaultConnection) {
    return {
      intent: "reconnect",
      connectionId: page.defaultConnection.id,
    };
  }
  if (page.connections.length > 0) {
    throw new Error(
      "This connector has saved accounts but no default. Choose an account in Connectors settings.",
    );
  }
  return { intent: "add" };
}

export async function readConnectorOAuthCompletion(
  createClient: ApiClientFactory,
  target: ConnectorAccountTarget,
  account: PlatformConnectorAccountMutationIntent,
  attemptId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await accept(
    createClient(connectorAccountsContract).oauthCompletion({
      params: { attemptId },
      query: target,
      fetchOptions: { signal },
    }),
    [200, 404],
  );
  if (
    result.status === 404 ||
    (account.intent === "reconnect" &&
      result.body.connectionId !== account.connectionId)
  ) {
    return null;
  }
  return result.body.connectionId;
}

export const settingsConnectorAccounts = createConnectorAccountListSignals({
  includeBuiltinScopeMismatch: true,
});

const invalidateConnectorAccounts$ = command(({ set }, signal: AbortSignal) => {
  set(settingsConnectorAccounts.reload$, signal);
});

export const readConnectorAccount$ = command(
  async (
    { get },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ): Promise<ConnectorAccountConnection> => {
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).connection({
        params: { connectionId: args.connectionId },
        query: args.target,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const renameConnectorAccount$ = command(
  async (
    { get, set },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
      readonly displayName: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await accept(
      get(apiClient$)(connectorAccountsContract).rename({
        params: { connectionId: args.connectionId },
        body: { target: args.target, displayName: args.displayName },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(invalidateConnectorAccounts$, signal);
  },
);

export const setDefaultConnectorAccount$ = command(
  async (
    { get, set },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await accept(
      get(apiClient$)(connectorAccountsContract).setDefault({
        params: { connectionId: args.connectionId },
        body: { target: args.target },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(invalidateConnectorAccounts$, signal);
  },
);

export const connectorAccountDeletionImpact$ = command(
  async (
    { get },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ) => {
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).deletionImpact({
        params: { connectionId: args.connectionId },
        query: args.target,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const deleteConnectorAccount$ = command(
  async (
    { get, set },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ) => {
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).delete({
        params: { connectionId: args.connectionId },
        body: { target: args.target },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(invalidateConnectorAccounts$, signal);
    set(reloadUserConnectedConnectors$);
    return result.body;
  },
);

export const connectorAccountSetup = createConnectorAccountListSignals();
export const connectorAccountSetupRef$ = onRef(
  command(({ set }, element: HTMLDivElement, signal: AbortSignal) => {
    const customConnectorId = element.dataset.accountSetupCustomId;
    if (!customConnectorId) {
      return;
    }
    set(
      connectorAccountSetup.setTarget$,
      { kind: "custom", customConnectorId },
      signal,
    );
    signal.addEventListener("abort", () => {
      set(connectorAccountSetup.clearTarget$);
    });
  }),
);
