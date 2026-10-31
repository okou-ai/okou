import { command, computed, state, type Command, type Computed } from "ccstate";
import { uuid } from "zod";
import { connectorAccountsContract } from "@okouai/api-contracts/client/connector-accounts";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { isConnectorChangedPayloadFor } from "../connector-change.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  customConnectorSlugSchema,
  isIntegrationManagedCustomConnector,
  customConnectorManagedStatusSchema,
} from "@okouai/api-contracts/validators/custom-connectors";
import type {
  CustomConnectorSlug,
  CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";
import {
  connectorCatalogItemBySlug,
  withMemberAccount,
} from "../external/connectors.ts";
import {
  connectBuiltinConnectorNoAuth$,
  connectBuiltinConnectorOAuthAuthCode$,
  builtinConnectorCurrentConnectionStatus,
  getBuiltinConnectorStatusDirectConnectMethod,
  resetBuiltinManualGrantForm$,
} from "../okou-page/settings/connectors.ts";
import {
  customConnectorAuthorizedAgentsById$,
  customConnectors$,
  resetCustomConnectorConnectInput$,
  setCustomConnectorAgentAuthorization$,
} from "../okou-page/settings/custom-connectors.ts";
import { resolvePlatformOriginForTarget } from "../api-base.ts";
import { authorizeConnector$ as authorizeDirectedConnector$ } from "../connectors-page/directed-authorize-slug.ts";
import { isAgentConnectorAuthorized } from "../okou-page/agent-connector-authorizations.ts";
import { defaultBuiltinConnectorAccountOptions } from "../okou-page/settings/connector-account-dialogs.ts";
import { readConnectorAccountPage } from "../okou-page/settings/connector-accounts.ts";
import {
  chatActionCallbackFromUrl,
  runChatActionCallback$,
  type ChatActionCallback,
} from "./action-callback.ts";
import {
  chatActionIdMatches,
  type ChatActionContext,
  type ChatActionParseResult,
} from "./chat-action-context.ts";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";

interface ConnectorActionDescriptorBase {
  readonly agentId: string;
  readonly originalUrl: string;
  readonly callbackPrompt: ChatActionCallback["callbackPrompt"];
  readonly threadId: ChatActionCallback["threadId"];
}

export interface CatalogConnectorActionDescriptor extends ConnectorActionDescriptorBase {
  readonly kind: "catalog";
  readonly connectorSlug: ConnectorSlug;
}

export interface ExactReconnectConnectorActionDescriptor extends ConnectorActionDescriptorBase {
  readonly kind: "catalog-reconnect";
  readonly connectorSlug: ConnectorSlug;
  readonly connectionId: string;
}

export interface CustomConnectorActionDescriptor extends ConnectorActionDescriptorBase {
  readonly kind: "custom";
  readonly connectorSlug: CustomConnectorSlug;
}

export type ConnectorActionDescriptor =
  | CatalogConnectorActionDescriptor
  | ExactReconnectConnectorActionDescriptor
  | CustomConnectorActionDescriptor;

interface ConnectorSignalState {
  readonly available$: Computed<Promise<boolean>>;
  readonly connected$: Computed<Promise<boolean>>;
  readonly authorized$: Computed<Promise<boolean>>;
  readonly complete$: Computed<Promise<boolean>>;
  readonly activate$: Command<Promise<void>, [AbortSignal]>;
}

export type CatalogConnectorSignals = CatalogConnectorActionDescriptor &
  ConnectorSignalState & {
    readonly subscribe$: Command<void, [AbortSignal]>;
    readonly catalogItem$: Computed<
      Promise<PlatformConnectorCatalogStatusItem | null>
    >;
  };

export type ExactReconnectConnectorSignals =
  ExactReconnectConnectorActionDescriptor & {
    readonly status$: Computed<
      Promise<
        | { readonly kind: "unavailable" }
        | {
            readonly kind: "ready";
            readonly account: ConnectorAccountConnection;
            readonly catalogItem: PlatformConnectorCatalogStatusItem;
          }
      >
    >;
    readonly activate$: Command<Promise<void>, [AbortSignal]>;
    readonly subscribe$: Command<void, [AbortSignal]>;
  };

export type CustomConnectorSignals = CustomConnectorActionDescriptor &
  ConnectorSignalState & {
    readonly connector$: Computed<Promise<CustomConnectorResponse | null>>;
  };

export type ConnectorSignals =
  | CatalogConnectorSignals
  | ExactReconnectConnectorSignals
  | CustomConnectorSignals;

type ConnectorCardSignalsRegistry = CardSignalsRegistry<
  ConnectorActionDescriptor,
  ConnectorSignals
>;

type ActiveExactReconnectConnectorAction =
  ExactReconnectConnectorActionDescriptor & {
    readonly catalogItem: PlatformConnectorCatalogStatusItem;
    readonly account: ConnectorAccountConnection;
  };

type ActiveCustomConnectorAction = CustomConnectorActionDescriptor & {
  readonly recordConnection$: Command<void, [CustomConnectorResponse, boolean]>;
};

type ReadCatalogAccountCommand = Command<
  Promise<PlatformConnectorCatalogStatusItem | null>,
  [ActiveCatalogConnectorAction | undefined, AbortSignal]
>;

type ActiveCatalogConnectorAction = CatalogConnectorActionDescriptor & {
  readonly catalogItem: PlatformConnectorCatalogStatusItem;
  readonly readAccount$: ReadCatalogAccountCommand;
};

type ActiveChatConnectorAction =
  | ActiveCatalogConnectorAction
  | ActiveExactReconnectConnectorAction
  | ActiveCustomConnectorAction;

const activeChatConnectorActionState$ = state<ActiveChatConnectorAction | null>(
  null,
);

export const activeChatConnectorAction$ = computed((get) => {
  return get(activeChatConnectorActionState$);
});

export const closeChatConnectorActionConnectDialog$ = command(({ set }) => {
  set(activeChatConnectorActionState$, null);
});

export function parseConnectorAuthorizeUrl(
  value: string,
  context: ChatActionContext | undefined,
): ChatActionParseResult<ConnectorActionDescriptor> {
  const appOrigin = window.location.origin;
  const canonicalAppOrigin = resolvePlatformOriginForTarget("app");
  if (!URL.canParse(value, appOrigin)) {
    return { status: "unrelated" };
  }
  const url = new URL(value, appOrigin);
  if (url.origin !== appOrigin && url.origin !== canonicalAppOrigin) {
    return { status: "unrelated" };
  }

  const match = url.pathname.match(
    /^\/connectors\/([^/]+)\/(authorize|connect|reconnect\/([^/]+))$/u,
  );
  if (!match) {
    return { status: "unrelated" };
  }
  const connectorSlug = match?.[1]?.toLowerCase();
  const action = match?.[2];
  const agentId = url.searchParams.get("agentId");
  if (!context || !agentId || !chatActionIdMatches(agentId, context.agentId)) {
    return { status: "invalid", originalUrl: value };
  }

  const callback = chatActionCallbackFromUrl(url, context);
  if (!callback) {
    return { status: "invalid", originalUrl: value };
  }
  const parsedCatalogSlug = connectorSlugSchema.safeParse(connectorSlug);
  const connectionId = match[3];
  if (connectionId !== undefined) {
    const parsedConnectionId = uuid().safeParse(connectionId);
    if (!parsedCatalogSlug.success || !parsedConnectionId.success) {
      return { status: "invalid", originalUrl: value };
    }
    return {
      status: "valid",
      descriptor: {
        kind: "catalog-reconnect",
        connectorSlug: parsedCatalogSlug.data,
        connectionId: parsedConnectionId.data,
        agentId: context.agentId,
        originalUrl: value,
        ...callback,
      },
    };
  }
  if (parsedCatalogSlug.success) {
    return {
      status: "valid",
      descriptor: {
        kind: "catalog",
        connectorSlug: parsedCatalogSlug.data,
        agentId: context.agentId,
        originalUrl: value,
        ...callback,
      },
    };
  }

  const parsedCustomSlug = customConnectorSlugSchema.safeParse(connectorSlug);
  if (!parsedCustomSlug.success || action !== "connect") {
    return { status: "invalid", originalUrl: value };
  }
  return {
    status: "valid",
    descriptor: {
      kind: "custom",
      connectorSlug: parsedCustomSlug.data,
      agentId: context.agentId,
      originalUrl: value,
      ...callback,
    },
  };
}

const runConnectorActionCallback$ = command(
  async (
    { set },
    descriptor: ConnectorActionDescriptor,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!descriptor.callbackPrompt || !descriptor.threadId) {
      return;
    }
    await set(
      runChatActionCallback$,
      {
        threadId: descriptor.threadId,
        agentId: descriptor.agentId,
        callbackPrompt: descriptor.callbackPrompt,
      },
      signal,
    );
  },
);

export const completeExactReconnectChatAction$ = command(
  async (
    { get, set },
    active: ActiveExactReconnectConnectorAction,
    connectionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    // A late connection response must not continue a dialog the user closed
    // or a previous attempt with the same link that they have since reopened.
    if (get(activeChatConnectorActionState$) !== active) {
      return;
    }
    if (connectionId !== active.account.id) {
      throw new Error("Reconnected a different connector account");
    }
    await set(runConnectorActionCallback$, active, signal);
  },
);

export const refreshCustomConnectorChatAccount$ = command(
  async (
    { get, set },
    active: ActiveCustomConnectorAction,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    if (get(activeChatConnectorActionState$) !== active) {
      return false;
    }
    const connector = (await get(customConnectors$)).find((candidate) => {
      return candidate.slug === active.connectorSlug;
    });
    signal.throwIfAborted();
    if (!connector) {
      throw new Error("This connector is no longer available.");
    }
    const accountPage = isIntegrationManagedCustomConnector(connector)
      ? null
      : await readConnectorAccountPage(
          get(apiClient$),
          { kind: "custom", customConnectorId: connector.id },
          signal,
        );
    signal.throwIfAborted();
    if (get(activeChatConnectorActionState$) !== active) {
      return false;
    }
    const connected = accountPage
      ? accountPage.defaultConnection?.connectionStatus === "connected"
      : customConnectorManagedStatusSchema.parse(connector).connected;
    set(active.recordConnection$, connector, connected);
    return connected;
  },
);

export const completeCustomConnectorChatAction$ = command(
  async (
    { get, set },
    active: ActiveCustomConnectorAction,
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      refreshCustomConnectorChatAccount$,
      active,
      signal,
    );
    signal.throwIfAborted();
    if (get(activeChatConnectorActionState$) !== active) {
      return;
    }
    if (!connected) {
      throw new Error(
        "The default account still needs attention. Review its accounts in Connectors settings.",
      );
    }
    await set(runConnectorActionCallback$, active, signal);
  },
);

export const completeCatalogConnectorChatAction$ = command(
  async (
    { get, set },
    active: ActiveCatalogConnectorAction,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (get(activeChatConnectorActionState$) !== active) {
      return;
    }
    const item = await set(active.readAccount$, active, signal);
    signal.throwIfAborted();
    if (get(activeChatConnectorActionState$) !== active) {
      return;
    }
    requireCompletedCatalogAccount(item);
    await set(runConnectorActionCallback$, active, signal);
  },
);

function requireCompletedCatalogAccount(
  item: PlatformConnectorCatalogStatusItem | null,
): void {
  const status = item ? builtinConnectorCurrentConnectionStatus(item) : null;
  if (
    !item?.connected ||
    status === "unavailable" ||
    status === "reconnect-required"
  ) {
    throw new Error(
      "The default account still needs attention. Review its accounts in Connectors settings.",
    );
  }
}

type CatalogConnectorActivationSignals = Pick<
  CatalogConnectorSignals,
  "available$" | "catalogItem$" | "connected$"
> & { readonly readAccount$: ReadCatalogAccountCommand };

function createCatalogConnectorActivation(
  descriptor: CatalogConnectorActionDescriptor,
  signals: CatalogConnectorActivationSignals,
): CatalogConnectorSignals["activate$"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const available = await get(signals.available$);
    signal.throwIfAborted();
    if (!available) {
      return;
    }

    const catalogItem = await set(signals.readAccount$, undefined, signal);
    signal.throwIfAborted();
    const connected = catalogItem?.connected === true;
    const status =
      catalogItem === null
        ? null
        : builtinConnectorCurrentConnectionStatus(catalogItem);
    if (status === "unavailable") {
      throw new Error("Connector account metadata is unavailable.");
    }
    const reconnectRequired = status === "reconnect-required";
    if (connected && !reconnectRequired) {
      await set(
        authorizeDirectedConnector$,
        descriptor.connectorSlug,
        descriptor.agentId,
        signal,
      );
      await set(runConnectorActionCallback$, descriptor, signal);
      return;
    }

    const connector = catalogItem;
    if (!connector) {
      return;
    }
    const accountOptions = defaultBuiltinConnectorAccountOptions(connector);
    if (!accountOptions) {
      return;
    }

    const directConnectMethod =
      getBuiltinConnectorStatusDirectConnectMethod(connector);
    if (!directConnectMethod) {
      set(resetBuiltinManualGrantForm$, connector.slug);
      set(activeChatConnectorActionState$, {
        ...descriptor,
        catalogItem: connector,
        readAccount$: signals.readAccount$,
      });
      return;
    }

    const connectOptions = {
      connectorLabel: connector.label,
      connectorIcon: connector.icon,
      agentId: descriptor.agentId,
      ...accountOptions,
    };
    const connectionCompleted =
      directConnectMethod.kind === "browser-auth"
        ? await set(
            connectBuiltinConnectorOAuthAuthCode$,
            descriptor.connectorSlug,
            directConnectMethod.authMethod,
            connectOptions,
            signal,
          )
        : await set(
            connectBuiltinConnectorNoAuth$,
            {
              connectorSlug: descriptor.connectorSlug,
              authMethod: directConnectMethod.authMethod,
              options: connectOptions,
            },
            signal,
          );
    if (connectionCompleted) {
      const current = await set(signals.readAccount$, undefined, signal);
      signal.throwIfAborted();
      requireCompletedCatalogAccount(current);
      await set(runConnectorActionCallback$, descriptor, signal);
    }
  });
}

function createCatalogConnectorSignals(
  descriptor: CatalogConnectorActionDescriptor,
): CatalogConnectorSignals {
  const definition$ = connectorCatalogItemBySlug(descriptor.connectorSlug);
  const accountChanges = createBuiltinConnectorAccountInvalidation(
    descriptor.connectorSlug,
  );
  const catalogItem$ = computed(async (get) => {
    get(accountChanges.revision$);
    const definition = await get(definition$);
    if (!definition) {
      return null;
    }
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).connections({
        query: {
          kind: "builtin",
          connectorSlug: descriptor.connectorSlug,
          limit: 1,
          includeScopeMismatch: "true",
        },
      }),
      [200],
    );
    return withMemberAccount(definition, result.body.defaultConnection);
  });
  const readAccount$ = command(
    async (
      { get },
      expectedAction: ActiveCatalogConnectorAction | undefined,
      signal: AbortSignal,
    ) => {
      const definition = await get(definition$);
      signal.throwIfAborted();
      if (!definition) {
        return null;
      }
      const accounts = await readConnectorAccountPage(
        get(apiClient$),
        { kind: "builtin", connectorSlug: descriptor.connectorSlug },
        signal,
        { includeBuiltinScopeMismatch: true },
      );
      signal.throwIfAborted();
      if (
        expectedAction &&
        get(activeChatConnectorActionState$) !== expectedAction
      ) {
        return null;
      }
      return withMemberAccount(definition, accounts.defaultConnection);
    },
  );

  const available$ = computed(async (get): Promise<boolean> => {
    const catalogItem = await get(catalogItem$);
    return catalogItem !== null;
  });

  const connected$ = computed(async (get): Promise<boolean> => {
    return (await get(catalogItem$))?.connected ?? false;
  });

  const authorized$ = computed(async (get): Promise<boolean> => {
    return await get(
      isAgentConnectorAuthorized({
        agentId: descriptor.agentId,
        connectorSlug: descriptor.connectorSlug,
      }),
    );
  });

  const complete$ = computed(async (get): Promise<boolean> => {
    const available = await get(available$);
    if (!available) {
      return false;
    }

    const [connected, authorized, catalogItem] = await Promise.all([
      get(connected$),
      get(authorized$),
      get(catalogItem$),
    ]);
    const status =
      catalogItem === null
        ? null
        : builtinConnectorCurrentConnectionStatus(catalogItem);
    return (
      connected &&
      authorized &&
      catalogItem !== null &&
      status !== "reconnect-required" &&
      status !== "unavailable"
    );
  });

  const activate$ = createCatalogConnectorActivation(descriptor, {
    available$,
    catalogItem$,
    connected$,
    readAccount$,
  });

  return {
    ...descriptor,
    catalogItem$,
    available$,
    connected$,
    authorized$,
    complete$,
    activate$,
    subscribe$: accountChanges.subscribe$,
  };
}

function createBuiltinConnectorAccountInvalidation(
  connectorSlug: ConnectorSlug,
) {
  const revision$ = state(0);
  const invalidate$ = command(({ set }) => {
    set(revision$, (revision) => {
      return revision + 1;
    });
    return false;
  });
  const receive$ = command(({ set }, payload: unknown): boolean => {
    if (isConnectorChangedPayloadFor(payload, connectorSlug)) {
      set(invalidate$);
    }
    return false;
  });
  const subscribe$ = command(({ set }, signal: AbortSignal) => {
    set(
      setAblyPayloadLoop$,
      {
        topic: "connector:changed",
        loopCommand$: receive$,
        initializeCommand$: invalidate$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  });
  return { revision$, invalidate$, subscribe$ };
}

function createExactReconnectConnectorSignals(
  descriptor: ExactReconnectConnectorActionDescriptor,
): ExactReconnectConnectorSignals {
  const catalogItem$ = connectorCatalogItemBySlug(descriptor.connectorSlug);
  const accountChanges = createBuiltinConnectorAccountInvalidation(
    descriptor.connectorSlug,
  );
  const status$ = computed(async (get) => {
    get(accountChanges.revision$);
    const catalogItem = await get(catalogItem$);
    if (!catalogItem) {
      return { kind: "unavailable" as const };
    }
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).connection({
        params: { connectionId: descriptor.connectionId },
        query: { kind: "builtin", connectorSlug: descriptor.connectorSlug },
      }),
      [200, 404],
    );
    if (result.status === 404) {
      return { kind: "unavailable" as const };
    }
    const account = result.body;
    if (
      account.id.toLowerCase() !== descriptor.connectionId.toLowerCase() ||
      account.target.kind !== "builtin" ||
      account.target.connectorSlug !== descriptor.connectorSlug ||
      !catalogItem.authMethods.some((method) => {
        return (
          method.id === account.authMethod && method.grantKind !== "managed"
        );
      })
    ) {
      return { kind: "unavailable" as const };
    }
    return {
      kind: "ready" as const,
      account,
      catalogItem,
    };
  });

  const activate$ = command(async ({ get, set }, signal: AbortSignal) => {
    set(accountChanges.invalidate$);
    const status = await get(status$);
    signal.throwIfAborted();
    if (status.kind !== "ready") {
      return;
    }
    set(resetBuiltinManualGrantForm$, descriptor.connectorSlug);
    set(activeChatConnectorActionState$, {
      ...descriptor,
      catalogItem: status.catalogItem,
      account: status.account,
    });
  });

  return {
    ...descriptor,
    status$,
    activate$,
    subscribe$: accountChanges.subscribe$,
  };
}

function createCustomConnectorSignals(
  descriptor: CustomConnectorActionDescriptor,
): CustomConnectorSignals {
  const verifiedDefault$ = state<{
    readonly connector: CustomConnectorResponse;
    readonly connected: boolean;
  } | null>(null);
  const recordConnection$ = command(
    ({ set }, connector: CustomConnectorResponse, connected: boolean) => {
      set(verifiedDefault$, { connector, connected });
    },
  );
  const connector$ = computed(async (get) => {
    const connectors = await get(customConnectors$);
    return (
      connectors.find((connector) => {
        return connector.slug === descriptor.connectorSlug;
      }) ?? null
    );
  });

  const available$ = computed(async (get): Promise<boolean> => {
    return (await get(connector$)) !== null;
  });

  const connected$ = computed(async (get): Promise<boolean> => {
    const connector = await get(connector$);
    if (!connector) {
      return false;
    }
    const verified = get(verifiedDefault$);
    if (verified?.connector === connector) {
      return verified.connected;
    }
    return isIntegrationManagedCustomConnector(connector)
      ? customConnectorManagedStatusSchema.parse(connector).connected
      : false;
  });

  const authorized$ = computed(async (get): Promise<boolean> => {
    const connector = await get(connector$);
    if (!connector) {
      return false;
    }
    const authorizedAgentsByConnectorId = await get(
      customConnectorAuthorizedAgentsById$,
    );
    return (authorizedAgentsByConnectorId.get(connector.id) ?? []).some(
      (agent) => {
        return agent.agentId === descriptor.agentId;
      },
    );
  });

  const complete$ = computed(async (get): Promise<boolean> => {
    const available = await get(available$);
    if (!available) {
      return false;
    }
    const [connected, authorized] = await Promise.all([
      get(connected$),
      get(authorized$),
    ]);
    return connected && authorized;
  });

  const activate$ = command(async ({ get, set }, signal: AbortSignal) => {
    const connector = await get(connector$);
    signal.throwIfAborted();
    if (!connector) {
      return;
    }
    const accountPage = isIntegrationManagedCustomConnector(connector)
      ? null
      : await readConnectorAccountPage(
          get(apiClient$),
          { kind: "custom", customConnectorId: connector.id },
          signal,
        );
    signal.throwIfAborted();
    const connected = accountPage
      ? accountPage.defaultConnection?.connectionStatus === "connected"
      : await get(connected$);
    signal.throwIfAborted();
    if (accountPage) {
      set(verifiedDefault$, { connector, connected });
    }
    if (connected) {
      const alreadyAuthorized = await get(authorized$);
      signal.throwIfAborted();
      const authorized =
        alreadyAuthorized ||
        (await set(
          setCustomConnectorAgentAuthorization$,
          {
            agentId: descriptor.agentId,
            connectorId: connector.id,
            permissionBundleRef: connector.permissionBundleRef ?? null,
            authorized: true,
          },
          signal,
        ));
      signal.throwIfAborted();
      if (!authorized) {
        return;
      }
      await set(runConnectorActionCallback$, descriptor, signal);
      return;
    }

    set(resetCustomConnectorConnectInput$);
    set(activeChatConnectorActionState$, { ...descriptor, recordConnection$ });
  });

  return {
    ...descriptor,
    connector$,
    available$,
    connected$,
    authorized$,
    complete$,
    activate$,
  };
}

function createConnectorSignals(
  descriptor: ConnectorActionDescriptor,
): ConnectorSignals {
  switch (descriptor.kind) {
    case "catalog": {
      return createCatalogConnectorSignals(descriptor);
    }
    case "catalog-reconnect": {
      return createExactReconnectConnectorSignals(descriptor);
    }
    case "custom": {
      return createCustomConnectorSignals(descriptor);
    }
  }
}

export function createConnectorCardSignalsRegistry(): ConnectorCardSignalsRegistry {
  const subscribeCustom$ = command(() => {
    return undefined;
  });
  return createCardSignalsRegistry(
    (descriptor: ConnectorActionDescriptor) => {
      return descriptor.originalUrl;
    },
    createConnectorSignals,
    (signals) => {
      return signals.kind === "custom" ? subscribeCustom$ : signals.subscribe$;
    },
  );
}
