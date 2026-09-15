import { command, computed, state } from "ccstate";
import { withConnectorConnectionProgress } from "../../connector-connection-progress.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
  customConnectorListResponseSchema,
  customConnectorResponseSchema,
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
  type CustomConnectorValueInput,
  type UpdateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrants,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { IN_VITEST } from "../../../env.ts";
import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { agents$ } from "../../agent.ts";
import { searchParams$, updateSearchParams$ } from "../../route.ts";
import { setAblyLoop$ } from "../../realtime.ts";
import { waitLoopUntil, withCleanup } from "../../utils.ts";
import type { PlatformConnectorAccountMutationIntent } from "../../connector-domain.ts";
import {
  readConnectorAccountCount,
  readConnectorOAuthCompletion,
} from "./connector-accounts.ts";
import { resetConnectorAccountDialogs$ } from "./connector-account-dialogs.ts";

const internalReload$ = state(0);
const internalAuthorizedAgentsReload$ = state(0);

export type CustomConnectorAuthMethodType =
  | "none"
  | "api"
  | "automatic"
  | "oauth2";

export const customConnectorAuthorizationReloadVersion$ = computed((get) => {
  return get(internalAuthorizedAgentsReload$);
});

// ---------------------------------------------------------------------------
// Active tab on the Connectors settings page
// ---------------------------------------------------------------------------

type ConnectorsPageTab = "builtin" | "custom";

function normalizeConnectorsPageTab(value: string | null): ConnectorsPageTab {
  return value === "custom" ? "custom" : "builtin";
}

export const connectorsPageTab$ = computed((get) => {
  return normalizeConnectorsPageTab(get(searchParams$).get("tab"));
});
export const setConnectorsPageTab$ = command(({ get, set }, value: string) => {
  const tab = normalizeConnectorsPageTab(value);
  if (tab !== normalizeConnectorsPageTab(get(searchParams$).get("tab"))) {
    set(resetConnectorAccountDialogs$);
  }
  const next = new URLSearchParams(get(searchParams$));
  if (tab === "builtin") {
    next.delete("tab");
  } else {
    next.set("tab", tab);
  }
  set(updateSearchParams$, next);
});

/**
 * List of org custom connectors with canonical connection status.
 * Cache-busted by `reloadCustomConnectors$`.
 */
export const customConnectors$ = computed(
  async (get): Promise<CustomConnectorResponse[]> => {
    get(internalReload$);
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

    const allAgents = await get(agents$);
    const client = get(apiClient$)(agentCustomConnectorsContract);
    const rows = await Promise.all(
      allAgents.map(async (agent) => {
        const result = await accept(
          client.get({ params: { id: agent.agentId } }),
          [200, 404],
        );
        return result.status === 404 ? null : { agent, access: result.body };
      }),
    );
    return rows.filter((row): row is CustomConnectorAgentAuthorization => {
      return row !== null;
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

export const reloadCustomConnectorAuthorizedAgents$ = command(({ set }) => {
  set(internalAuthorizedAgentsReload$, (value) => {
    return value + 1;
  });
});

export const setCustomConnectorAgentAuthorization$ = command(
  async (
    { get, set },
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
    await withCleanup(
      accept(
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
      ),
      () => {
        set(reloadCustomConnectorAuthorizedAgents$);
      },
    );
    signal.throwIfAborted();
    return true;
  },
);

const bumpReload$ = command(({ set }) => {
  set(internalReload$, (v) => {
    return v + 1;
  });
});

export const retryCustomConnectors$ = command(({ set }) => {
  set(bumpReload$);
});

const reloadCustomConnectorsFromRealtime$ = command(({ set }) => {
  set(bumpReload$);
  return false;
});

export const subscribeCustomConnectorListChanged$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyLoop$,
      {
        topic: "customConnectorListChanged",
        loopCommand$: reloadCustomConnectorsFromRealtime$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);

type CustomConnectorAuthorizationTarget =
  | { readonly kind: "visible-agents" }
  | { readonly kind: "agent"; readonly agentId: string };

const authorizeCustomConnectorForTarget$ = command(
  async (
    { get, set },
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
    await withCleanup(
      Promise.all(
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
      ),
      () => {
        set(reloadCustomConnectorAuthorizedAgents$);
      },
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

interface CustomConnectorConnectionResult {
  readonly connected: boolean;
  readonly targetAuthorized: boolean;
  readonly connectionId: string | null;
}

export const createCustomConnector$ = command(
  async (
    { get, set },
    body: CreateCustomConnectorBody,
    _signal: AbortSignal,
  ): Promise<CustomConnectorResponse> => {
    const createClient = get(apiClient$);
    const client = createClient(customConnectorsContract);
    const result = await accept(
      client.create({
        body,
        fetchOptions: { signal: _signal },
      }),
      [201],
    );
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
    return connector;
  },
);

export const deleteCustomConnector$ = command(
  async ({ get, set }, id: string, _signal: AbortSignal): Promise<void> => {
    const createClient = get(apiClient$);
    const client = createClient(customConnectorByIdContract);
    await accept(
      client.delete({
        params: { id },
        fetchOptions: { signal: _signal },
      }),
      [204],
    );
    set(bumpReload$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.custom.toasts.deleted;
      }),
    );
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
    const initialAccountCount =
      args.authorizationTarget.kind === "visible-agents" &&
      args.account.intent === "add"
        ? await readConnectorAccountCount(
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
    const connector = customConnectorResponseSchema.parse(result.body);
    set(bumpReload$);
    if (!connector.connected) {
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
        target: args.authorizationTarget,
        initialAccountCount,
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
      connectionId: result.body.connectedAccountId ?? null,
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
  readonly account: PlatformConnectorAccountMutationIntent;
  readonly useDefaultConnectorProjection?: boolean;
}

const authorizeCompletedCustomConnectorTarget$ = command(
  async (
    { set },
    args: {
      readonly connector: CustomConnectorResponse | undefined;
      readonly target: CustomConnectorAuthorizationTarget;
      readonly initialAccountCount: number | undefined;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!args.connector?.connected) {
      return false;
    }
    if (
      args.target.kind === "visible-agents" &&
      args.initialAccountCount !== 0
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

const connectCustomConnectorAuthorizationForTargetCommand$ = command(
  async (
    { get, set },
    args: CustomConnectorAuthorizationTargetArgs,
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    const authWindow = window.open(
      "about:blank",
      "_blank",
      "width=600,height=700",
    );
    if (!authWindow) {
      throw new Error("Failed to open authorization window");
    }
    authWindow.opener = null;
    let navigated = false;
    let initialAccountCount: number | undefined;
    const startResult = await withCleanup(
      (async () => {
        const createClient = get(apiClient$);
        initialAccountCount =
          args.authorizationTarget.kind === "visible-agents" &&
          args.account.intent === "add"
            ? await readConnectorAccountCount(
                createClient,
                { kind: "custom", customConnectorId: args.id },
                signal,
              )
            : undefined;
        const client = createClient(customConnectorOAuth2Contract, {
          apiBase: "api",
        });
        const result = await accept(
          client.start({
            params: { id: args.id },
            body: { account: args.account },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
        if (result.body.result === "connected") {
          return result.body;
        }
        authWindow.location.href = result.body.authorizationUrl;
        navigated = true;
        return result.body;
      })(),
      () => {
        if (!navigated) {
          authWindow.close();
        }
      },
    );
    signal.throwIfAborted();
    if (startResult.result === "connected") {
      set(bumpReload$);
      const targetAuthorized = await set(
        authorizeCompletedCustomConnectorTarget$,
        {
          connector: startResult.connector,
          target: args.authorizationTarget,
          initialAccountCount,
        },
        signal,
      );
      return {
        connected: startResult.connector.connected,
        targetAuthorized,
        connectionId: startResult.connectedAccountId,
      };
    }
    await waitLoopUntil(
      () => {
        return authWindow.closed;
      },
      IN_VITEST ? 10 : 250,
      signal,
    );
    signal.throwIfAborted();
    set(bumpReload$);
    const connectors = await get(customConnectors$);
    signal.throwIfAborted();
    const connector = connectors.find((candidate) => {
      return candidate.id === args.id;
    });
    const connectionId = await readConnectorOAuthCompletion(
      get(apiClient$),
      { kind: "custom", customConnectorId: args.id },
      args.account,
      startResult.oauthAttemptId,
      signal,
    );
    signal.throwIfAborted();
    if (
      connectionId === null ||
      (args.useDefaultConnectorProjection &&
        connector?.connectedAccountId !== connectionId)
    ) {
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
        target: args.authorizationTarget,
        initialAccountCount,
      },
      signal,
    );
    return {
      connected: connector?.connected ?? false,
      targetAuthorized,
      connectionId,
    };
  },
);

const connectCustomConnectorAuthorizationForTarget$ =
  withConnectorConnectionProgress(
    connectCustomConnectorAuthorizationForTargetCommand$,
  );

export const connectCustomConnectorAuthorization$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly account: PlatformConnectorAccountMutationIntent;
      readonly useDefaultConnectorProjection?: boolean;
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

/** Custom connector cards have no inline connection indicator. */
export const connectCustomConnectorAuthorizationWithDialog$ =
  withConnectorConnectionProgress(
    command(
      async (
        { set },
        args: {
          readonly id: string;
          readonly account: PlatformConnectorAccountMutationIntent;
          readonly onSuccess: (connectionId: string | null) => Promise<void>;
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
          await args.onSuccess(result.connectionId);
        }
      },
    ),
    { showDialog: true },
  );

export const connectCustomConnectorAuthorizationForAgent$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly agentId: string;
      readonly account: PlatformConnectorAccountMutationIntent;
      readonly useDefaultConnectorProjection?: boolean;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    return await set(
      connectCustomConnectorAuthorizationForTarget$,
      {
        id: args.id,
        account: args.account,
        ...(args.useDefaultConnectorProjection
          ? { useDefaultConnectorProjection: true as const }
          : {}),
        authorizationTarget: { kind: "agent", agentId: args.agentId },
      },
      signal,
    );
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
