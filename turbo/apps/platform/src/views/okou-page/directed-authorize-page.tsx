import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button } from "@okouai/ui";
import {
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogAuthMethodDetail } from "@okouai/api-contracts/contracts/connector-catalog";
import type {
  PlatformConnectorAccountMutationIntent,
  PlatformConnectorCatalogStatusItem,
} from "../../signals/connector-domain.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  connectConnectorOAuthAuthCode$,
  type ConnectorConnectSuccess,
  connectConnectorNoAuth$,
  connectFlowConnectorSlug$,
  getConnectorStatusConnectLaunchMode,
  getOnlyAvailableStatusBrowserAuthMethodDetail,
  getOnlyAvailableStatusNoAuthMethod,
  justConnectedSlugs$,
  pollingOAuthAuthCodeConnectorSlug$,
  type ConnectorConnectionResult,
} from "../../signals/okou-page/settings/connectors.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  directedAuthorizeSlug$,
  directedAuthorizeAgentId$,
  directedAuthorizeAgentName$,
  agentEnabledConnectorSlugs$,
  authorizeConnector$,
  directedAuthorizeConnectModalKey$,
  setDirectedAuthorizeConnectModalKey$,
} from "../../signals/connectors-page/directed-authorize-slug.ts";
import {
  routeChatActionCallback$,
  runChatActionCallback$,
} from "../../signals/chat-page/action-callback.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { reloadAgentConnectorAuthorizations$ } from "../../signals/okou-page/agent-connector-authorizations.ts";
import { Check, Loader2 } from "lucide-react";
import { DirectedCardShell } from "./directed-shared.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { useTranslation } from "react-i18next";
import { assistantName$ } from "../../signals/branding.ts";
import { defaultBuiltinConnectorAccountOptions } from "../../signals/okou-page/settings/connector-account-dialogs.ts";

// ---------------------------------------------------------------------------
// Action button / authorized badge
// ---------------------------------------------------------------------------

function AuthorizeAction({
  isAuthorized,
  isConnecting,
  disabled,
  agentName,
  onAuthorize,
}: {
  isAuthorized: boolean;
  isConnecting: boolean;
  disabled: boolean;
  agentName: string;
  onAuthorize: () => void;
}) {
  const { t } = useTranslation();
  if (isAuthorized) {
    return (
      <div className="inline-flex h-9 w-[140px] items-center justify-center gap-1.5 text-sm font-medium text-emerald-600">
        <Check size={16} />
        {t(($) => {
          return $.connectors.card.authorized;
        })}
      </div>
    );
  }
  return (
    <Button
      type="button"
      disabled={isConnecting || disabled}
      onClick={onAuthorize}
      className="disabled:opacity-60"
    >
      {isConnecting && <Loader2 size={14} className="animate-spin" />}
      {isConnecting
        ? t(($) => {
            return $.connectors.actions.connecting;
          })
        : t(
            ($) => {
              return $.connectors.directed.authorizeAgent;
            },
            { agent: agentName },
          )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

function useDirectedAuthorizeParams(): {
  readonly connectorSlug: ConnectorSlug;
  readonly agentId: string;
} | null {
  const connectorSlug = useGet(directedAuthorizeSlug$);
  const agentId = useGet(directedAuthorizeAgentId$);
  if (!connectorSlug || !agentId) {
    return null;
  }
  const parsed = connectorSlugSchema.safeParse(connectorSlug);
  if (!parsed.success) {
    return null;
  }
  return { connectorSlug: parsed.data, agentId };
}

function useDirectedAuthorizeCatalogState(connectorSlug: ConnectorSlug | null) {
  const justConnected = useGet(justConnectedSlugs$);
  const allLoadable = useLastLoadable(connectorCatalogStatus$);
  const catalogLoaded = allLoadable.state === "hasData";
  const allData = catalogLoaded ? allLoadable.data.connectors : [];
  const item = connectorSlug
    ? allData.find((connector) => {
        return connector.slug === connectorSlug;
      })
    : undefined;
  const isConnected =
    connectorSlug !== null &&
    (justConnected.has(connectorSlug) || item?.connected === true);
  return {
    item,
    isConnected,
    catalogLoading:
      connectorSlug !== null &&
      !justConnected.has(connectorSlug) &&
      allLoadable.state === "loading",
    unavailable:
      connectorSlug !== null && catalogLoaded && !item && !isConnected,
  };
}

function useDirectedAuthorizePermissionState(
  connectorSlug: ConnectorSlug | null,
  agentId: string | null,
  isAuthorizing: boolean,
) {
  const enabledLoadable = useLastLoadable(agentEnabledConnectorSlugs$);
  const enabledData =
    agentId !== null &&
    enabledLoadable.state === "hasData" &&
    enabledLoadable.data.agentId === agentId
      ? enabledLoadable.data
      : null;
  const enabledConnectorSlugs =
    enabledData === null ? [] : enabledData.enabledConnectorSlugs;
  return {
    isAuthorized:
      connectorSlug !== null &&
      agentId !== null &&
      enabledConnectorSlugs.includes(connectorSlug),
    permissionLoading:
      isAuthorizing ||
      (agentId !== null &&
        (enabledLoadable.state === "loading" ||
          (enabledLoadable.state === "hasData" && enabledData === null))),
  };
}

function useDirectedAuthorizeAgentName(agentId: string | null): string {
  const agentNameLoadable = useLastLoadable(directedAuthorizeAgentName$);
  const assistantName = useGet(assistantName$);
  if (
    agentNameLoadable.state !== "hasData" ||
    agentNameLoadable.data.agentId !== agentId ||
    !agentNameLoadable.data.displayName
  ) {
    return assistantName;
  }
  return agentNameLoadable.data.displayName;
}

function canAuthorizeConnector(
  item: Pick<PlatformConnectorCatalogStatusItem, "authMethods"> | undefined,
  isConnected: boolean,
): boolean {
  return isConnected || (item ? item.authMethods.length > 0 : false);
}

function useDirectedAuthorizeConnectModalOpen(
  connectorSlug: ConnectorSlug | null,
  agentId: string | null,
  signal: AbortSignal,
): boolean {
  const key = useGet(directedAuthorizeConnectModalKey$);
  return (
    key?.connectorSlug === connectorSlug &&
    key.agentId === agentId &&
    key.signal === signal
  );
}

function runDirectedAuthorize(
  params: {
    readonly canAuthorize: boolean;
    readonly isConnected: boolean;
    readonly item: PlatformConnectorCatalogStatusItem | undefined;
    readonly connectorSlug: ConnectorSlug;
    readonly connectorLabel: string;
    readonly agentId: string;
    readonly authMethod: PublicConnectorCatalogAuthMethodDetail | null;
    readonly authorize: (
      connectorSlug: ConnectorSlug,
      agentId: string,
      signal: AbortSignal,
    ) => Promise<void>;
    readonly connect: (
      connectorSlug: ConnectorSlug,
      method: PublicConnectorCatalogAuthMethodDetail,
      options: {
        readonly connectorLabel?: string;
        readonly connectorIcon: PlatformConnectorCatalogStatusItem["icon"];
        readonly onSuccess?: ConnectorConnectSuccess;
        readonly agentId?: string;
        readonly account: PlatformConnectorAccountMutationIntent;
        readonly useDefaultConnectorProjection?: boolean;
      },
      signal: AbortSignal,
    ) => Promise<ConnectorConnectionResult | false>;
    readonly connectNoAuth: (
      args: {
        readonly connectorSlug: ConnectorSlug;
        readonly authMethod: ConnectorAuthMethodId;
        readonly options: {
          readonly connectorLabel?: string;
          readonly agentId?: string;
          readonly account: PlatformConnectorAccountMutationIntent;
          readonly useDefaultConnectorProjection?: boolean;
        };
      },
      signal: AbortSignal,
    ) => Promise<ConnectorConnectionResult | false>;
    readonly openConnectModal: () => void;
    readonly reloadAuthorization: () => void;
    readonly onSuccess: ConnectorConnectSuccess;
  },
  signal: AbortSignal,
): void {
  if (!params.canAuthorize) {
    return;
  }
  if (params.isConnected) {
    detach(
      (async () => {
        await params.authorize(params.connectorSlug, params.agentId, signal);
        await params.onSuccess(null, signal);
      })(),
      Reason.DomCallback,
    );
    return;
  }
  const accountOptions = params.item
    ? defaultBuiltinConnectorAccountOptions(params.item)
    : null;
  if (!accountOptions) {
    return;
  }
  const launchMode = params.item
    ? getConnectorStatusConnectLaunchMode(params.item)
    : "modal";
  const browserAuthMethod =
    launchMode === "browser-auth" ? params.authMethod : null;
  const noAuthMethod =
    launchMode === "no-auth" && params.item
      ? getOnlyAvailableStatusNoAuthMethod(params.item)
      : null;
  if ((browserAuthMethod && params.item) || noAuthMethod) {
    detach(
      (async () => {
        let connected: ConnectorConnectionResult | false = false;
        if (browserAuthMethod && params.item) {
          connected = await params.connect(
            params.connectorSlug,
            browserAuthMethod,
            {
              connectorLabel: params.connectorLabel,
              connectorIcon: params.item.icon,
              agentId: params.agentId,
              ...accountOptions,
              onSuccess: async (connectionId, attemptSignal) => {
                params.reloadAuthorization();
                await params.onSuccess(connectionId, attemptSignal);
              },
            },
            signal,
          );
        } else if (noAuthMethod) {
          connected = await params.connectNoAuth(
            {
              connectorSlug: params.connectorSlug,
              authMethod: noAuthMethod,
              options: {
                connectorLabel: params.connectorLabel,
                agentId: params.agentId,
                ...accountOptions,
              },
            },
            signal,
          );
        } else {
          return;
        }
        if (connected && !browserAuthMethod) {
          params.reloadAuthorization();
          await params.onSuccess(connected.connectionId, signal);
        }
      })(),
      Reason.DomCallback,
    );
    return;
  }
  if (params.item && params.item.authMethods.length > 0) {
    params.openConnectModal();
  }
}

function DirectedAuthorizeConnectModal({
  open,
  item,
  agentId,
  reloadAuthorization,
  handleAuthorizeSuccess,
  close,
}: {
  open: boolean;
  item: PlatformConnectorCatalogStatusItem | null | undefined;
  agentId: string;
  reloadAuthorization: () => void;
  handleAuthorizeSuccess: ConnectorConnectSuccess;
  close: () => void;
}) {
  if (!open || !item) {
    return null;
  }
  const accountOptions = defaultBuiltinConnectorAccountOptions(item);
  if (!accountOptions) {
    return null;
  }

  return (
    <ConnectModal
      item={item}
      agentId={agentId}
      accountOptions={accountOptions}
      onSuccess={async (connectionId, signal) => {
        reloadAuthorization();
        await handleAuthorizeSuccess(connectionId, signal);
      }}
      onClose={close}
    />
  );
}

function useDirectedAuthorizeSuccess(
  params: ReturnType<typeof useDirectedAuthorizeParams>,
): ConnectorConnectSuccess {
  const actionCallback = useGet(routeChatActionCallback$);
  const runCallback = useSet(runChatActionCallback$);
  const agentId = params?.agentId;
  return async (_connectionId, signal) => {
    if (agentId && actionCallback.callbackPrompt && actionCallback.threadId) {
      await runCallback(
        {
          threadId: actionCallback.threadId,
          agentId,
          callbackPrompt: actionCallback.callbackPrompt,
        },
        signal,
      );
    }
  };
}

function DirectedAuthorizeCard() {
  const { t } = useTranslation();
  const params = useDirectedAuthorizeParams();
  const pollingConnectorSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const connectFlowConnectorSlug = useGet(connectFlowConnectorSlug$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const [authorizeLoadable, authorize] = useLoadableSet(authorizeConnector$);
  const reloadAuthorization = useSet(reloadAgentConnectorAuthorizations$);
  const signal = useGet(pageSignal$);
  const setDirectedAuthorizeConnectModalKey = useSet(
    setDirectedAuthorizeConnectModalKey$,
  );
  const handleAuthorizeSuccess = useDirectedAuthorizeSuccess(params);
  const connectorSlugForState = params?.connectorSlug ?? null;
  const agentName = useDirectedAuthorizeAgentName(params?.agentId ?? null);
  const { item, isConnected, catalogLoading, unavailable } =
    useDirectedAuthorizeCatalogState(connectorSlugForState);
  const { isAuthorized, permissionLoading } =
    useDirectedAuthorizePermissionState(
      connectorSlugForState,
      params?.agentId ?? null,
      authorizeLoadable.state === "loading",
    );
  const connectModalOpen = useDirectedAuthorizeConnectModalOpen(
    connectorSlugForState,
    params?.agentId ?? null,
    signal,
  );

  if (!params || unavailable) {
    return null;
  }

  const { connectorSlug, agentId } = params;
  const isConnecting =
    pollingConnectorSlug === connectorSlug ||
    connectFlowConnectorSlug === connectorSlug;

  const isLoading = catalogLoading || permissionLoading;
  const canAuthorize = canAuthorizeConnector(item, isConnected);
  const selectedAuthMethod = item
    ? getOnlyAvailableStatusBrowserAuthMethodDetail(item)
    : null;
  const connectorLabel = item?.label ?? connectorSlug;
  const connectorDescription = item?.description ?? "";

  const handleAuthorize = () => {
    runDirectedAuthorize(
      {
        canAuthorize,
        isConnected,
        item,
        connectorSlug,
        connectorLabel,
        agentId,
        authMethod: selectedAuthMethod,
        authorize,
        connect,
        connectNoAuth,
        reloadAuthorization,
        onSuccess: handleAuthorizeSuccess,
        openConnectModal: () => {
          setDirectedAuthorizeConnectModalKey({
            connectorSlug,
            agentId,
            signal,
          });
        },
      },
      signal,
    );
  };

  return (
    <>
      <DirectedCardShell
        icon={<ConnectorIcon icon={item?.icon} size={20} />}
        title={
          isAuthorized
            ? t(
                ($) => {
                  return $.connectors.directed.authorized;
                },
                { connector: connectorLabel },
              )
            : t(
                ($) => {
                  return $.connectors.directed.needsConnector;
                },
                { agent: agentName, connector: connectorLabel },
              )
        }
        description={connectorDescription}
        isLoading={isLoading}
      >
        <div className="flex items-center justify-center">
          <AuthorizeAction
            isAuthorized={isAuthorized}
            isConnecting={isConnecting}
            disabled={!canAuthorize}
            agentName={agentName}
            onAuthorize={handleAuthorize}
          />
        </div>
      </DirectedCardShell>
      <DirectedAuthorizeConnectModal
        open={connectModalOpen}
        item={item}
        agentId={agentId}
        reloadAuthorization={reloadAuthorization}
        handleAuthorizeSuccess={handleAuthorizeSuccess}
        close={() => {
          setDirectedAuthorizeConnectModalKey(null);
        }}
      />
    </>
  );
}

export function DirectedAuthorizePage() {
  return <DirectedAuthorizeCard />;
}
