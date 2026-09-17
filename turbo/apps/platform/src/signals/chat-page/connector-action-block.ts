import { command, computed, state, type Command, type Computed } from "ccstate";
import { withConnectorConnectionProgress } from "../connector-connection-progress.ts";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  customConnectorSlugSchema,
  type CustomConnectorResponse,
  type CustomConnectorSlug,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";
import { connectorCatalogItemBySlug } from "../external/connectors.ts";
import {
  connectConnectorNoAuth$,
  connectConnectorOAuthAuthCode$,
  connectorCurrentConnectionStatus,
  getConnectorStatusDirectConnectMethod,
  resetManualGrantForm$,
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

export interface CustomConnectorActionDescriptor extends ConnectorActionDescriptorBase {
  readonly kind: "custom";
  readonly connectorSlug: CustomConnectorSlug;
}

export type ConnectorActionDescriptor =
  | CatalogConnectorActionDescriptor
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
    readonly catalogItem$: Computed<
      Promise<PlatformConnectorCatalogStatusItem | null>
    >;
  };

export type CustomConnectorSignals = CustomConnectorActionDescriptor &
  ConnectorSignalState & {
    readonly connector$: Computed<Promise<CustomConnectorResponse | null>>;
  };

export type ConnectorSignals = CatalogConnectorSignals | CustomConnectorSignals;

type ConnectorCardSignalsRegistry = CardSignalsRegistry<
  ConnectorActionDescriptor,
  ConnectorSignals
>;

type ActiveChatConnectorAction =
  | (CatalogConnectorActionDescriptor & {
      readonly catalogItem: PlatformConnectorCatalogStatusItem;
    })
  | CustomConnectorActionDescriptor;

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
    /^\/connectors\/([^/]+)\/(authorize|connect)$/u,
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

type CatalogConnectorActivationSignals = Pick<
  CatalogConnectorSignals,
  "available$" | "catalogItem$" | "connected$"
>;

function createCatalogConnectorActivation(
  descriptor: CatalogConnectorActionDescriptor,
  signals: CatalogConnectorActivationSignals,
): CatalogConnectorSignals["activate$"] {
  return withConnectorConnectionProgress(
    command(async ({ get, set }, signal: AbortSignal) => {
      const available = await get(signals.available$);
      signal.throwIfAborted();
      if (!available) {
        return;
      }

      const [connected, catalogItem] = await Promise.all([
        get(signals.connected$),
        get(signals.catalogItem$),
      ]);
      signal.throwIfAborted();
      const reconnectRequired =
        catalogItem !== null &&
        connectorCurrentConnectionStatus(catalogItem) === "reconnect-required";
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
        getConnectorStatusDirectConnectMethod(connector);
      if (!directConnectMethod) {
        set(resetManualGrantForm$, connector.slug);
        set(activeChatConnectorActionState$, {
          ...descriptor,
          catalogItem: connector,
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
              connectConnectorOAuthAuthCode$,
              descriptor.connectorSlug,
              directConnectMethod.authMethod,
              connectOptions,
              signal,
            )
          : await set(
              connectConnectorNoAuth$,
              {
                connectorSlug: descriptor.connectorSlug,
                authMethod: directConnectMethod.authMethod,
                options: connectOptions,
              },
              signal,
            );
      if (connectionCompleted) {
        await set(runConnectorActionCallback$, descriptor, signal);
      }
    }),
  );
}

function createCatalogConnectorSignals(
  descriptor: CatalogConnectorActionDescriptor,
): CatalogConnectorSignals {
  const catalogItem$ = connectorCatalogItemBySlug(descriptor.connectorSlug);

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
    return (
      connected &&
      authorized &&
      catalogItem !== null &&
      connectorCurrentConnectionStatus(catalogItem) !== "reconnect-required"
    );
  });

  const activate$ = createCatalogConnectorActivation(descriptor, {
    available$,
    catalogItem$,
    connected$,
  });

  return {
    ...descriptor,
    catalogItem$,
    available$,
    connected$,
    authorized$,
    complete$,
    activate$,
  };
}

function createCustomConnectorSignals(
  descriptor: CustomConnectorActionDescriptor,
): CustomConnectorSignals {
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
    return (await get(connector$))?.connected ?? false;
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
    if (connector.connected) {
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
    set(activeChatConnectorActionState$, descriptor);
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
  return descriptor.kind === "catalog"
    ? createCatalogConnectorSignals(descriptor)
    : createCustomConnectorSignals(descriptor);
}

export function createConnectorCardSignalsRegistry(): ConnectorCardSignalsRegistry {
  return createCardSignalsRegistry((descriptor: ConnectorActionDescriptor) => {
    return descriptor.originalUrl;
  }, createConnectorSignals);
}
