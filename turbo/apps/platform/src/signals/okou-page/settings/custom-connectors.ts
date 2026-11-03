import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES,
  isIntegrationManagedCustomConnector,
  customConnectorListResponseSchema,
  customConnectorResponseSchema,
  setCustomConnectorValuesResponseSchema,
  startCustomConnectorOAuth2ResponseSchema,
  customConnectorManagedStatusSchema,
} from "@okouai/api-contracts/validators/custom-connectors";
import type {
  CreateCustomConnectorBody,
  CustomConnectorValueInput,
  UpdateCustomConnectorBody,
  CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/client/custom-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/client/agent-custom-connectors";
import type { AgentCustomConnectorGrants } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { IN_VITEST } from "../../../env.ts";
import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import { agents$ } from "../../agent.ts";
import { reloadUserConnectedConnectors$ } from "../connector-overview.ts";
import { customConnectorAccountProjectionVersion$ } from "../connector-account-projection.ts";
import {
  connectorAgentAccess$,
  connectorAuthorizationVersion$,
  reloadConnectorAgentAccess$,
} from "./connector-agent-access.ts";
import { resetSignal, waitLoopUntil, withCleanup } from "../../utils.ts";
import type { PlatformConnectorAccountMutationIntent } from "../../connector-domain.ts";
import {
  hasSavedConnectorAccounts,
  resolveCustomConnectorAccountMutation,
  readConnectorOAuthCompletion,
  readConnectorAccountCompletion,
} from "./connector-accounts.ts";
import type { ConnectorConnectSuccess } from "./connectors.ts";
import type {
  ConnectorAccountConnectMode,
  CustomConnectorAccountMutationIntent,
  CustomConnectorAccountMutationOptions,
} from "./connector-account-dialogs.ts";

const internalReload$ = state(0);

export type CustomConnectorAuthMethodType =
  "none" | "api" | "automatic" | "oauth2";

export const customConnectorAuthorizationReloadVersion$ =
  connectorAuthorizationVersion$;

/**
 * List of org custom connectors with canonical connection status.
 * Cache-busted by `reloadCustomConnectors$`.
 */
export const customConnectors$ = computed(
  async (get): Promise<CustomConnectorResponse[]> => {
    get(internalReload$);
    get(customConnectorAccountProjectionVersion$);
    const createClient = get(apiClient$);
    const client = createClient(customConnectorsContract);
    const result = await accept(client.list(), [200]);
    return customConnectorListResponseSchema.parse(result.body).connectors;
  },
);

export interface CustomConnectorAgentAuthorization {
  readonly agent: AgentResponse;
  readonly access: AgentCustomConnectorGrants;
}

export const customConnectorAgentAuthorizations$ = computed(
  async (get): Promise<readonly CustomConnectorAgentAuthorization[]> => {
    get(customConnectorAuthorizationReloadVersion$);
    const connectors = await get(customConnectors$);
    if (connectors.length === 0) {
      return [];
    }

    const [allAgents, access] = await Promise.all([
      get(agents$),
      get(connectorAgentAccess$),
    ]);
    const grantsByAgent = new Map<
      string,
      AgentCustomConnectorGrants["grants"]
    >();
    const visibleAgentIds = new Set(access.visibleAgentIds);
    for (const { agentId, connectorId, permissionNames } of access.custom) {
      const grants = grantsByAgent.get(agentId) ?? [];
      grantsByAgent.set(agentId, [
        ...grants,
        { customConnectorId: connectorId, permissionNames },
      ]);
    }
    return allAgents
      .filter((agent) => {
        return visibleAgentIds.has(agent.agentId);
      })
      .map((agent) => {
        return {
          agent,
          access: { grants: grantsByAgent.get(agent.agentId) ?? [] },
        };
      });
  },
);

export const customConnectorAuthorizedAgentsById$ = computed(
  async (get): Promise<ReadonlyMap<string, readonly AgentResponse[]>> => {
    const rows = await get(customConnectorAgentAuthorizations$);
    const agentsByConnectorId = new Map<string, AgentResponse[]>();
    for (const row of rows) {
      for (const grant of row.access.grants) {
        const authorizedAgents =
          agentsByConnectorId.get(grant.customConnectorId) ?? [];
        authorizedAgents.push(row.agent);
        agentsByConnectorId.set(grant.customConnectorId, authorizedAgents);
      }
    }
    return agentsByConnectorId;
  },
);

export const reloadCustomConnectorAuthorizedAgents$ =
  reloadConnectorAgentAccess$;

export const setCustomConnectorAgentAuthorization$ = command(
  async (
    { get },
    args: {
      readonly agentId: string;
      readonly connectorId: string;
      readonly permissionBundleRef: string | null;
      readonly authorized: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (args.authorized && args.permissionBundleRef) {
      return false;
    }
    const client = get(apiClient$)(agentCustomConnectorsContract);
    await accept(
      client.update({
        params: { id: args.agentId },
        body: {
          grants: [
            {
              customConnectorId: args.connectorId,
              permissionNames: [],
            },
          ],
          operation: args.authorized ? "add" : "remove",
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return true;
  },
);

const bumpReload$ = command(({ set }) => {
  set(internalReload$, (v) => {
    return v + 1;
  });
  set(reloadUserConnectedConnectors$);
});

type CustomConnectorAuthorizationTarget =
  | { readonly kind: "visible-agents" }
  | { readonly kind: "agent"; readonly agentId: string };

const authorizeCustomConnectorForTarget$ = command(
  async (
    { get },
    args: {
      readonly connectorId: string;
      readonly target: CustomConnectorAuthorizationTarget;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const agentIds =
      args.target.kind === "agent"
        ? [args.target.agentId]
        : (await get(agents$)).map((agent) => {
            return agent.agentId;
          });
    signal.throwIfAborted();
    const client = get(apiClient$)(agentCustomConnectorsContract);
    await Promise.all(
      agentIds.map(async (agentId) => {
        await accept(
          client.update({
            params: { id: agentId },
            body: {
              grants: [
                {
                  customConnectorId: args.connectorId,
                  permissionNames: [],
                },
              ],
              operation: "add",
            },
            fetchOptions: { signal },
          }),
          args.target.kind === "agent" ? [200] : [200, 404],
        );
      }),
    );
    signal.throwIfAborted();
  },
);

const isCustomConnectorAuthorizedForTarget$ = command(
  async (
    { get },
    args: {
      readonly connectorId: string;
      readonly target: CustomConnectorAuthorizationTarget;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (args.target.kind === "visible-agents") {
      return false;
    }
    const client = get(apiClient$)(agentCustomConnectorsContract);
    const result = await accept(
      client.get({
        params: { id: args.target.agentId },
        fetchOptions: { signal },
      }),
      [200, 404],
    );
    signal.throwIfAborted();
    return (
      result.status === 200 &&
      result.body.grants.some((grant) => {
        return grant.customConnectorId === args.connectorId;
      })
    );
  },
);

type CustomConnectorConnectionResult = {
  readonly targetAuthorized: boolean;
} & (
  | { readonly connected: true; readonly connectionId: string }
  | { readonly connected: false; readonly connectionId: string | null }
);

async function readCustomConnectorCompletion(
  createClient: ApiClientFactory,
  connector: CustomConnectorResponse | undefined,
  customConnectorId: string,
  connectionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (connector && isIntegrationManagedCustomConnector(connector)) {
    return customConnectorManagedStatusSchema.parse(connector).connected;
  }
  return await readConnectorAccountCompletion(
    createClient,
    { kind: "custom", customConnectorId },
    connectionId,
    signal,
  );
}

export const createCustomConnector$ = command(
  async (
    { get, set },
    body: CreateCustomConnectorBody,
    onCreated: ((connector: CustomConnectorResponse) => void) | undefined,
    signal: AbortSignal,
  ): Promise<CustomConnectorResponse> => {
    const dialog = get(internalDialog$);
    const createClient = get(apiClient$);
    const client = createClient(customConnectorsContract);
    const result = await accept(
      client.create({
        body,
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    const connector = customConnectorResponseSchema.parse(result.body);
    set(bumpReload$);
    toast.success(
      i18n.t(
        ($) => {
          return $.connectors.custom.toasts.created;
        },
        { connector: connector.displayName },
      ),
    );
    if (get(internalDialog$) === dialog) {
      set(closeCustomConnectorDialog$);
      onCreated?.(connector);
    }
    return connector;
  },
);

export const updateCustomConnector$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly body: UpdateCustomConnectorBody;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorResponse> => {
    const dialog = get(internalDialog$);
    const createClient = get(apiClient$);
    const client = createClient(customConnectorByIdContract);
    const result = await accept(
      client.update({
        params: { id: args.id },
        body: args.body,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const connector = customConnectorResponseSchema.parse(result.body);
    set(bumpReload$);
    toast.success(
      i18n.t(
        ($) => {
          return $.connectors.custom.toasts.updated;
        },
        { connector: connector.displayName },
      ),
    );
    if (get(internalDialog$) === dialog) {
      set(closeCustomConnectorDialog$);
    }
    return connector;
  },
);

export const deleteCustomConnector$ = command(
  async ({ get, set }, id: string, signal: AbortSignal): Promise<void> => {
    const dialog = get(internalDialog$);
    const createClient = get(apiClient$);
    const client = createClient(customConnectorByIdContract);
    await accept(
      client.delete({
        params: { id },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(bumpReload$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.custom.toasts.deleted;
      }),
    );
    if (get(internalDialog$) === dialog) {
      set(closeCustomConnectorDialog$);
    }
  },
);

const setCustomConnectorValuesForTarget$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly values: readonly CustomConnectorValueInput[];
      readonly authorizationTarget: CustomConnectorAuthorizationTarget;
      readonly account: PlatformConnectorAccountMutationIntent;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    const createClient = get(apiClient$);
    const hadSavedAccounts =
      args.authorizationTarget.kind === "visible-agents" &&
      args.account.intent === "add"
        ? await hasSavedConnectorAccounts(
            createClient,
            { kind: "custom", customConnectorId: args.id },
            signal,
          )
        : undefined;
    const client = createClient(customConnectorValuesContract);
    const result = await accept(
      client.set({
        params: { id: args.id },
        body: {
          account: args.account,
          values: [...args.values],
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const connector = setCustomConnectorValuesResponseSchema.parse(result.body);
    set(bumpReload$);
    const connectionId = connector.connectionId;
    if (
      args.account.intent === "reconnect" &&
      connectionId !== args.account.connectionId
    ) {
      throw new Error("Connector account response identity mismatch.");
    }
    const connected = await readCustomConnectorCompletion(
      createClient,
      connector,
      args.id,
      connectionId,
      signal,
    );
    if (!connected) {
      return {
        connected: false,
        targetAuthorized: false,
        connectionId: null,
      };
    }
    const targetAuthorized = await set(
      authorizeCompletedCustomConnectorTarget$,
      {
        connector,
        accountComplete: connected,
        target: args.authorizationTarget,
        hadSavedAccounts,
      },
      signal,
    );
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.connectors.custom.toasts.connected;
      }),
    );
    return {
      connected: true,
      targetAuthorized,
      connectionId,
    };
  },
);

export const setCustomConnectorValues$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly values: readonly CustomConnectorValueInput[];
      readonly account: PlatformConnectorAccountMutationIntent;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    return await set(
      setCustomConnectorValuesForTarget$,
      {
        ...args,
        authorizationTarget: { kind: "visible-agents" },
      },
      signal,
    );
  },
);

export const setCustomConnectorValuesForAgent$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly values: readonly CustomConnectorValueInput[];
      readonly agentId: string;
      readonly account: PlatformConnectorAccountMutationIntent;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    return await set(
      setCustomConnectorValuesForTarget$,
      {
        id: args.id,
        values: args.values,
        account: args.account,
        authorizationTarget: { kind: "agent", agentId: args.agentId },
      },
      signal,
    );
  },
);

interface CustomConnectorAuthorizationTargetArgs {
  readonly id: string;
  readonly authorizationTarget: CustomConnectorAuthorizationTarget;
  readonly account: CustomConnectorAccountMutationIntent;
  readonly onSuccess?: (
    result: CustomConnectorConnectionResult,
    signal: AbortSignal,
  ) => Promise<void>;
}

const startCustomConnectorAuthorization$ = command(
  async (
    { get },
    args: {
      readonly id: string;
      readonly account: PlatformConnectorAccountMutationIntent;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(customConnectorOAuth2Contract, {
      apiBase: "api",
    });
    const result = await accept(
      client.start({
        params: { id: args.id },
        body: { account: args.account },
        fetchOptions: { signal },
      }),
      [200],
      signal,
      {
        expectedErrors: {
          400: Object.values(
            CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES,
          ).filter((code) => {
            return (
              code !==
              CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE
            );
          }),
          502: [
            CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE,
          ],
        },
      },
    );
    return {
      ...result,
      body: startCustomConnectorOAuth2ResponseSchema.parse(result.body),
    };
  },
);

const authorizeCompletedCustomConnectorTarget$ = command(
  async (
    { set },
    args: {
      readonly connector: CustomConnectorResponse | undefined;
      readonly accountComplete: boolean;
      readonly target: CustomConnectorAuthorizationTarget;
      readonly hadSavedAccounts: boolean | undefined;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!args.accountComplete || !args.connector) {
      return false;
    }
    if (
      args.target.kind === "visible-agents" &&
      args.hadSavedAccounts !== false
    ) {
      return false;
    }
    if (!args.connector.permissionBundleRef) {
      await set(
        authorizeCustomConnectorForTarget$,
        {
          connectorId: args.connector.id,
          target: args.target,
        },
        signal,
      );
      return true;
    }
    return await set(
      isCustomConnectorAuthorizedForTarget$,
      { connectorId: args.connector.id, target: args.target },
      signal,
    );
  },
);

function openCustomConnectorAuthorizationWindow(signal: AbortSignal) {
  const authWindow = window.open(
    "about:blank",
    "_blank",
    "width=600,height=700",
  );
  if (!authWindow) {
    throw new Error("Failed to open authorization window");
  }
  authWindow.opener = null;
  signal.addEventListener(
    "abort",
    () => {
      authWindow.close();
    },
    { once: true },
  );
  return authWindow;
}

async function waitForCustomConnectorAuthorizationWindow(
  authWindow: Window,
  signal: AbortSignal,
) {
  await waitLoopUntil(
    () => {
      return authWindow.closed;
    },
    IN_VITEST ? 10 : 250,
    signal,
  );
  signal.throwIfAborted();
}

function completedCustomConnectorAccountId(
  receipt: {
    readonly connectionId: string;
  },
  account: PlatformConnectorAccountMutationIntent,
) {
  const connectionId = receipt.connectionId;
  if (account.intent === "reconnect" && connectionId !== account.connectionId) {
    throw new Error("Connector account response identity mismatch.");
  }
  return connectionId;
}

const connectCustomConnectorAuthorizationForTargetCommand$ = command(
  async (
    { get, set },
    args: CustomConnectorAuthorizationTargetArgs,
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    const authWindow = openCustomConnectorAuthorizationWindow(signal);
    let navigated = false;
    let hadSavedAccounts: boolean | undefined;
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    const { startResult, account } = await withCleanup(
      (async () => {
        const createClient = get(apiClient$);
        const account = await resolveCustomConnectorAccountMutation(
          createClient,
          args.id,
          args.account,
          signal,
        );
        signal.throwIfAborted();
        hadSavedAccounts =
          args.authorizationTarget.kind === "visible-agents" &&
          account.intent === "add"
            ? await hasSavedConnectorAccounts(
                createClient,
                { kind: "custom", customConnectorId: args.id },
                signal,
              )
            : undefined;
        const result = await set(
          startCustomConnectorAuthorization$,
          { id: args.id, account },
          signal,
        );
        signal.throwIfAborted();
        if (result.body.result === "authorization") {
          authWindow.location.href = result.body.authorizationUrl;
          navigated = true;
        }
        return { startResult: result.body, account };
      })(),
      () => {
        if (!navigated) {
          authWindow.close();
        }
      },
    );
    signal.throwIfAborted();
    if (startResult.result === "connected") {
      const connectionId = completedCustomConnectorAccountId(
        startResult,
        account,
      );
      const connected = await readCustomConnectorCompletion(
        get(apiClient$),
        startResult.connector,
        args.id,
        connectionId,
        signal,
      );
      set(bumpReload$);
      const targetAuthorized = await set(
        authorizeCompletedCustomConnectorTarget$,
        {
          connector: startResult.connector,
          accountComplete: connected,
          target: args.authorizationTarget,
          hadSavedAccounts,
        },
        signal,
      );
      return {
        connected,
        targetAuthorized,
        connectionId,
      };
    }
    await waitForCustomConnectorAuthorizationWindow(authWindow, signal);
    set(bumpReload$);
    const connectors = await get(customConnectors$);
    signal.throwIfAborted();
    const connector = connectors.find((candidate) => {
      return candidate.id === args.id;
    });
    const connectionId = await readConnectorOAuthCompletion(
      get(apiClient$),
      { kind: "custom", customConnectorId: args.id },
      account,
      startResult.oauthAttemptId,
      signal,
    );
    signal.throwIfAborted();
    if (connectionId === null) {
      return {
        connected: false,
        targetAuthorized: false,
        connectionId: null,
      };
    }
    const connected = await readCustomConnectorCompletion(
      get(apiClient$),
      connector,
      args.id,
      connectionId,
      signal,
    );
    const targetAuthorized = await set(
      authorizeCompletedCustomConnectorTarget$,
      {
        connector,
        accountComplete: connected,
        target: args.authorizationTarget,
        hadSavedAccounts,
      },
      signal,
    );
    return {
      connected,
      targetAuthorized,
      connectionId,
    };
  },
);

const connectCustomConnectorAuthorizationForTarget$ = command(
  async (
    { set },
    args: CustomConnectorAuthorizationTargetArgs,
    signal: AbortSignal,
  ) => {
    const result = await set(
      connectCustomConnectorAuthorizationForTargetCommand$,
      args,
      signal,
    );
    signal.throwIfAborted();
    if (result.connected) {
      await args.onSuccess?.(result, signal);
      signal.throwIfAborted();
    }
    return result;
  },
);

export const connectCustomConnectorAuthorization$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly account: CustomConnectorAccountMutationIntent;
      readonly onSuccess?: CustomConnectorAuthorizationTargetArgs["onSuccess"];
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    return await set(
      connectCustomConnectorAuthorizationForTarget$,
      {
        ...args,
        authorizationTarget: { kind: "visible-agents" },
      },
      signal,
    );
  },
);

/** Complete a card-triggered connection and its continuation. */
export const connectCustomConnectorAuthorizationAndSettle$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly account: PlatformConnectorAccountMutationIntent;
      readonly onSuccess: ConnectorConnectSuccess;
    },
    signal: AbortSignal,
  ) => {
    const result = await set(
      connectCustomConnectorAuthorization$,
      { id: args.id, account: args.account },
      signal,
    );
    if (result.connected) {
      signal.throwIfAborted();
      await args.onSuccess(result.connectionId, signal);
    }
  },
);

export const connectCustomConnectorAuthorizationForAgent$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly agentId: string;
      readonly account: CustomConnectorAccountMutationIntent;
      readonly onSuccess?: CustomConnectorAuthorizationTargetArgs["onSuccess"];
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    return await set(
      connectCustomConnectorAuthorizationForTarget$,
      {
        id: args.id,
        account: args.account,
        authorizationTarget: { kind: "agent", agentId: args.agentId },
        onSuccess: args.onSuccess,
      },
      signal,
    );
  },
);

const resetCustomConnectorConnectionSignal$ = resetSignal();
const closeCustomConnectorConnection$ = command(
  ({ set }, onClose: (() => void) | undefined) => {
    set(resetCustomConnectorConnectInput$);
    if (onClose) {
      onClose();
    } else {
      set(closeCustomConnectorDialog$);
    }
  },
);
export const cancelCustomConnectorConnection$ = command(
  ({ set }, onClose: (() => void) | undefined) => {
    set(resetCustomConnectorConnectionSignal$);
    set(closeCustomConnectorConnection$, onClose);
  },
);

interface CustomConnectorConnectionInput {
  readonly connector: CustomConnectorResponse;
  readonly agentId?: string;
  readonly values: readonly CustomConnectorValueInput[];
  readonly accountOptions: CustomConnectorAccountMutationOptions;
  readonly accountMode?: ConnectorAccountConnectMode;
  readonly onConnected?: ConnectorConnectSuccess;
  readonly onSuccess?: ConnectorConnectSuccess;
  readonly onClose?: () => void;
}

const runCustomConnectorConnection$ = command(
  async (
    { get, set },
    args: CustomConnectorConnectionInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const finish = async (
      result: CustomConnectorConnectionResult,
      attemptSignal: AbortSignal,
    ) => {
      if (result.connected) {
        await args.onConnected?.(result.connectionId, attemptSignal);
        attemptSignal.throwIfAborted();
      }
      if (result.connected && (result.targetAuthorized || args.accountMode)) {
        await args.onSuccess?.(result.connectionId, attemptSignal);
        attemptSignal.throwIfAborted();
      }
    };
    if (
      args.connector.authMode === "oauth" ||
      args.connector.authMode === "automatic"
    ) {
      const options = {
        id: args.connector.id,
        ...args.accountOptions,
        onSuccess: finish,
      };
      const result = args.agentId
        ? await set(
            connectCustomConnectorAuthorizationForAgent$,
            { ...options, agentId: args.agentId },
            signal,
          )
        : await set(connectCustomConnectorAuthorization$, options, signal);
      return result.connected;
    }
    const account = await resolveCustomConnectorAccountMutation(
      get(apiClient$),
      args.connector.id,
      args.accountOptions.account,
      signal,
    );
    signal.throwIfAborted();
    const options = {
      id: args.connector.id,
      values: args.values,
      account,
    };
    const result = args.agentId
      ? await set(
          setCustomConnectorValuesForAgent$,
          { ...options, agentId: args.agentId },
          signal,
        )
      : await set(setCustomConnectorValues$, options, signal);
    await finish(result, signal);
    return result.connected;
  },
);

/** One loadable owns connection, success callbacks, and dialog completion. */
export const submitCustomConnectorConnection$ = command(
  async (
    { set },
    args: CustomConnectorConnectionInput,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const signal = set(resetCustomConnectorConnectionSignal$, parentSignal);
    const connected = await set(runCustomConnectorConnection$, args, signal);
    signal.throwIfAborted();
    if (connected) {
      set(closeCustomConnectorConnection$, args.onClose);
    }
  },
);

// ---------------------------------------------------------------------------
// Settings page dialog state — tracks which dialog is open.
// ---------------------------------------------------------------------------

type DialogState =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "edit"; connector: CustomConnectorResponse }
  | { kind: "access"; connector: CustomConnectorResponse }
  | { kind: "delete"; connector: CustomConnectorResponse };

const internalDialog$ = state<DialogState>({ kind: "none" });
const internalEditConfirmation$ = state<{
  readonly connector: CustomConnectorResponse;
  readonly body: UpdateCustomConnectorBody;
} | null>(null);

export const customConnectorDialog$ = computed((get) => {
  return get(internalDialog$);
});
export const customConnectorEditConfirmation$ = computed((get) => {
  return get(internalEditConfirmation$);
});
export const openCustomConnectorCreateDialog$ = command(({ set }) => {
  set(internalCreateForm$, CREATE_FORM_DEFAULTS);
  set(internalEditConfirmation$, null);
  set(internalDialog$, { kind: "create" });
});
export const openCustomConnectorEditDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalCreateForm$, createFormFromConnector(connector));
    set(internalEditConfirmation$, null);
    set(internalDialog$, { kind: "edit", connector });
  },
);
export const openCustomConnectorEditConfirmationDialog$ = command(
  (
    { set },
    args: {
      readonly connector: CustomConnectorResponse;
      readonly body: UpdateCustomConnectorBody;
    },
  ) => {
    set(internalEditConfirmation$, args);
  },
);
export const closeCustomConnectorEditConfirmationDialog$ = command(
  ({ set }) => {
    set(internalEditConfirmation$, null);
  },
);
export const openCustomConnectorAccessDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalDialog$, { kind: "access", connector });
  },
);
export const openCustomConnectorDeleteDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalDialog$, { kind: "delete", connector });
  },
);
export const closeCustomConnectorDialog$ = command(({ set }) => {
  set(internalEditConfirmation$, null);
  set(internalDialog$, { kind: "none" });
});

// ---------------------------------------------------------------------------
// Create form state
// ---------------------------------------------------------------------------

export interface CustomConnectorCreateForm {
  kind: CustomConnectorResponse["kind"];
  displayName: string;
  prefixesRaw: string;
  mcpEndpoint: string;
  headerName: string;
  headerTemplate: string;
  authMethodTypes: readonly CustomConnectorAuthMethodType[];
  oauthAuthorizationUrl: string;
  oauthTokenUrl: string;
  oauthScopesRaw: string;
  oauthClientAuthentication: "client_secret_basic" | "client_secret_post";
  oauthPkceMethod: "none" | "S256";
  oauthResource: string;
  oauthAudience: string;
  oauthAccessType: string;
  oauthPrompt: string;
  oauthClientId: string;
  oauthClientSecret: string;
}

type CustomConnectorOAuthCreateForm = Pick<
  CustomConnectorCreateForm,
  | "oauthAuthorizationUrl"
  | "oauthTokenUrl"
  | "oauthScopesRaw"
  | "oauthClientAuthentication"
  | "oauthPkceMethod"
  | "oauthResource"
  | "oauthAudience"
  | "oauthAccessType"
  | "oauthPrompt"
  | "oauthClientId"
  | "oauthClientSecret"
>;

const OAUTH_CREATE_FORM_DEFAULTS = {
  oauthAuthorizationUrl: "",
  oauthTokenUrl: "",
  oauthScopesRaw: "",
  oauthClientAuthentication: "client_secret_post",
  oauthPkceMethod: "none",
  oauthResource: "",
  oauthAudience: "",
  oauthAccessType: "",
  oauthPrompt: "",
  oauthClientId: "",
  oauthClientSecret: "",
} as const satisfies CustomConnectorOAuthCreateForm;

const CREATE_FORM_DEFAULTS = {
  kind: "http",
  displayName: "",
  prefixesRaw: "",
  mcpEndpoint: "",
  headerName: "Authorization",
  headerTemplate: "Bearer {{secret}}",
  authMethodTypes: [],
  ...OAUTH_CREATE_FORM_DEFAULTS,
} as const satisfies CustomConnectorCreateForm;

function oauthCreateFormFromConnector(
  connector: CustomConnectorResponse,
): CustomConnectorOAuthCreateForm {
  const oauthConfig = connector.oauthConfig;
  if (!oauthConfig) {
    return { ...OAUTH_CREATE_FORM_DEFAULTS };
  }
  const authorizationParams = oauthConfig.authorizationParams;
  return {
    oauthAuthorizationUrl: oauthConfig.authorizationUrl,
    oauthTokenUrl: oauthConfig.tokenUrl,
    oauthScopesRaw: oauthConfig.scopes.join("\n"),
    oauthClientAuthentication: oauthConfig.tokenEndpointAuthMethod,
    oauthPkceMethod: oauthConfig.pkceMethod,
    oauthResource: authorizationParams.resource ?? "",
    oauthAudience: authorizationParams.audience ?? "",
    oauthAccessType: authorizationParams.access_type ?? "",
    oauthPrompt: authorizationParams.prompt ?? "",
    oauthClientId: oauthConfig.clientId,
    oauthClientSecret: "",
  };
}

function createFormFromConnector(
  connector: CustomConnectorResponse,
): CustomConnectorCreateForm {
  const firstHeader = connector.headerInjections[0];
  return {
    kind: connector.kind,
    displayName: connector.displayName,
    prefixesRaw:
      connector.kind === "http" ? connector.prefixTemplates.join("\n") : "",
    mcpEndpoint: connector.kind === "mcp" ? connector.endpoint : "",
    headerName: firstHeader?.name ?? CREATE_FORM_DEFAULTS.headerName,
    headerTemplate:
      firstHeader?.valueTemplate.replaceAll(
        "{{secrets.secret}}",
        "{{secret}}",
      ) ?? CREATE_FORM_DEFAULTS.headerTemplate,
    authMethodTypes: [
      connector.authMode === "none"
        ? "none"
        : connector.authMode === "automatic"
          ? "automatic"
          : connector.authMode === "oauth"
            ? "oauth2"
            : "api",
    ],
    ...oauthCreateFormFromConnector(connector),
  };
}

const internalCreateForm$ =
  state<CustomConnectorCreateForm>(CREATE_FORM_DEFAULTS);
export const customConnectorCreateForm$ = computed((get) => {
  return get(internalCreateForm$);
});
export const setCustomConnectorCreateField$ = command(
  (
    { get, set },
    field: Exclude<keyof CustomConnectorCreateForm, "authMethodTypes" | "kind">,
    value: string,
  ) => {
    const prev = get(internalCreateForm$);
    set(internalCreateForm$, { ...prev, [field]: value });
  },
);
export const setCustomConnectorCreateKind$ = command(
  ({ get, set }, kind: CustomConnectorResponse["kind"]) => {
    const form = get(internalCreateForm$);
    const authMethodTypes =
      kind === "mcp" && form.authMethodTypes.length === 0
        ? (["automatic"] as const)
        : kind === "http" && form.authMethodTypes.includes("automatic")
          ? []
          : form.authMethodTypes;
    set(internalCreateForm$, { ...form, kind, authMethodTypes });
  },
);
export const addCustomConnectorAuthMethod$ = command(
  ({ get, set }, type: CustomConnectorAuthMethodType) => {
    const form = get(internalCreateForm$);
    if (form.authMethodTypes.includes(type)) {
      return;
    }
    set(internalCreateForm$, {
      ...form,
      authMethodTypes: [type],
    });
  },
);
export const removeCustomConnectorAuthMethod$ = command(
  ({ get, set }, type: CustomConnectorAuthMethodType) => {
    const form = get(internalCreateForm$);
    set(internalCreateForm$, {
      ...form,
      authMethodTypes: form.authMethodTypes.filter((value) => {
        return value !== type;
      }),
    });
  },
);
// ---------------------------------------------------------------------------
// Connect form state
// ---------------------------------------------------------------------------

interface CustomConnectorConnectForm {
  readonly values: Readonly<Record<string, string>>;
}

const CONNECT_FORM_DEFAULTS = {
  values: {},
} as const satisfies CustomConnectorConnectForm;

const internalConnectForm$ = state<CustomConnectorConnectForm>(
  CONNECT_FORM_DEFAULTS,
);
export const customConnectorConnectForm$ = computed((get) => {
  return get(internalConnectForm$);
});
export const setCustomConnectorConnectField$ = command(
  ({ get, set }, args: { readonly key: string; readonly value: string }) => {
    const form = get(internalConnectForm$);
    set(internalConnectForm$, {
      values: { ...form.values, [args.key]: args.value },
    });
  },
);
export const resetCustomConnectorConnectInput$ = command(({ set }) => {
  set(internalConnectForm$, CONNECT_FORM_DEFAULTS);
});
