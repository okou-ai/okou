import { command } from "ccstate";
import { onRef } from "../../utils.ts";
import { reloadUserConnectedConnectors$ } from "../connector-overview.ts";
import { invalidateConnectorAccountProjection$ } from "../connector-account-projection.ts";
import { connectorAccountsContract } from "@okouai/api-contracts/client/connector-accounts";
import { connectorAccountConnectionSchema } from "@okouai/api-contracts/validators/connector-accounts";
import type {
  ConnectorAccountConnection,
  ConnectorAccountMutationIntent,
  ConnectorAccountTarget,
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
  options: {
    readonly includeBuiltinScopeMismatch?: boolean;
    readonly limit?: number;
  } = {},
) {
  const result = await accept(
    createClient(connectorAccountsContract).connections({
      query: {
        ...target,
        limit: options.limit ?? 50,
        ...(target.kind === "builtin" && options.includeBuiltinScopeMismatch
          ? { includeScopeMismatch: "true" as const }
          : {}),
      },
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  return result.body;
}

export async function hasSavedConnectorAccounts(
  createClient: ApiClientFactory,
  target: ConnectorAccountTarget,
  signal: AbortSignal,
): Promise<boolean> {
  const page = await readConnectorAccountPage(createClient, target, signal, {
    limit: 1,
  });
  return page.connections.length > 0;
}

/** Check the current default when the user explicitly grants account access. */
export async function requireCustomConnectorAccountReady(
  createClient: ApiClientFactory,
  customConnectorId: string,
  signal: AbortSignal,
): Promise<void> {
  const page = await readConnectorAccountPage(
    createClient,
    { kind: "custom", customConnectorId },
    signal,
  );
  signal.throwIfAborted();
  if (page.defaultConnection?.connectionStatus !== "connected") {
    throw new Error(
      "This connector needs a connected, fully configured default account. Review its accounts in Connectors settings and try again.",
    );
  }
}

/** Local connection requirements, distinct from HTTP request failures. */
export class ConnectorConnectionError extends Error {}

/** Completion validates canonical facts for the exact operated account. */
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
  const parsed = connectorAccountConnectionSchema.safeParse(result.body);
  if (
    !parsed.success ||
    parsed.data.id !== connectionId ||
    connectorAccountTargetKey(parsed.data.target) !==
      connectorAccountTargetKey(target)
  ) {
    throw new ConnectorConnectionError(
      "Connector account setup information is unavailable.",
    );
  }
  const account = parsed.data;
  if (account.connectionStatus === "connected") {
    return true;
  }
  if (
    account.reconnectReason === "configuration_incomplete" ||
    account.reconnectReason === "configuration_invalid"
  ) {
    throw new ConnectorConnectionError(
      "This account needs additional setup. Review its connector settings and try again.",
    );
  }
  return false;
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
    set(invalidateConnectorAccountProjection$, args.target);
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
    set(invalidateConnectorAccountProjection$, args.target);
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
