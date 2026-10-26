import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button } from "@okouai/ui";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import type { ConnectorConnectSuccess } from "../../signals/okou-page/settings/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  directedAuthorizeCatalogItem$,
  directedAuthorizeSlug$,
  directedAuthorizeAgentId$,
  directedAuthorizeAgentName$,
  agentEnabledConnectorSlugs$,
  authorizeDirectedConnector$,
  completeDirectedConnectorAuthorization$,
  directedAuthorizeConnectModalKey$,
  setDirectedAuthorizeConnectModalKey$,
} from "../../signals/connectors-page/directed-authorize-slug.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { routeChatActionCallback$ } from "../../signals/chat-page/action-callback.ts";
import { Check, CircleAlert, Loader2 } from "lucide-react";
import { DirectedActionError, DirectedCardShell } from "./directed-shared.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { assistantName$ } from "../../signals/branding.ts";
import { defaultBuiltinConnectorAccountOptions } from "../../signals/okou-page/settings/connector-account-dialogs.ts";

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
  return parsed.success ? { connectorSlug: parsed.data, agentId } : null;
}

function useDirectedAuthorizeCatalogState(connectorSlug: ConnectorSlug | null) {
  const itemLoadable = useLastLoadable(directedAuthorizeCatalogItem$);
  // The last entry is kept across a reload, never shown for another slug.
  const catalogLoaded =
    itemLoadable.state === "hasData" &&
    (itemLoadable.data === null || itemLoadable.data.slug === connectorSlug);
  const item =
    catalogLoaded && connectorSlug
      ? (itemLoadable.data ?? undefined)
      : undefined;
  const isConnected = connectorSlug !== null && item?.connected === true;
  return {
    item,
    isConnected,
    catalogFailed: itemLoadable.state === "hasError",
    catalogLoading:
      connectorSlug !== null &&
      itemLoadable.state !== "hasError" &&
      !catalogLoaded,
    unavailable:
      connectorSlug !== null && catalogLoaded && !item && !isConnected,
  };
}

function useDirectedAuthorizePermissionState(
  connectorSlug: ConnectorSlug | null,
  agentId: string | null,
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
    agentMissing: enabledData?.agentMissing ?? false,
    isAuthorized:
      connectorSlug !== null &&
      agentId !== null &&
      enabledConnectorSlugs.includes(connectorSlug),
    permissionLoading:
      agentId !== null &&
      (enabledLoadable.state === "loading" ||
        (enabledLoadable.state === "hasData" && enabledData === null)),
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

function directedAuthorizeTitle(
  t: TFunction<"common">,
  agentMissing: boolean,
  isAuthorized: boolean,
  connectorLabel: string,
  agentName: string,
): string {
  if (agentMissing) {
    return t(($) => {
      return $.authorization.permission.errors.agentNotFound;
    });
  }
  if (isAuthorized) {
    return t(
      ($) => {
        return $.connectors.directed.authorized;
      },
      {
        connector: connectorLabel,
      },
    );
  }
  return t(
    ($) => {
      return $.connectors.directed.needsConnector;
    },
    {
      agent: agentName,
      connector: connectorLabel,
    },
  );
}

function DirectedAuthorizeConnectModal({
  open,
  item,
  agentId,
  onSuccess,
  close,
}: {
  open: boolean;
  item: PlatformConnectorCatalogStatusItem | null | undefined;
  agentId: string;
  onSuccess: ConnectorConnectSuccess;
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
      onSuccess={onSuccess}
      onClose={close}
    />
  );
}

function useDirectedAuthorizeCardState() {
  const params = useDirectedAuthorizeParams();
  const [authorizeLoadable, authorize] = useLoadableSet(
    authorizeDirectedConnector$,
  );
  const completeAuthorization = useSet(completeDirectedConnectorAuthorization$);
  const actionCallback = useGet(routeChatActionCallback$);
  const signal = useGet(pageSignal$);
  const modalKey = useGet(directedAuthorizeConnectModalKey$);
  const setModalKey = useSet(setDirectedAuthorizeConnectModalKey$);
  const connectorSlugForState = params?.connectorSlug ?? null;
  const agentIdForState = params?.agentId ?? null;
  const agentName = useDirectedAuthorizeAgentName(agentIdForState);
  const { item, isConnected, catalogFailed, catalogLoading, unavailable } =
    useDirectedAuthorizeCatalogState(connectorSlugForState);
  const { agentMissing, isAuthorized, permissionLoading } =
    useDirectedAuthorizePermissionState(connectorSlugForState, agentIdForState);
  const connectModalOpen =
    modalKey?.connectorSlug === connectorSlugForState &&
    modalKey?.agentId === agentIdForState &&
    modalKey?.signal === signal;
  return {
    params,
    authorizeLoadable,
    authorize,
    completeAuthorization,
    actionCallback,
    signal,
    setModalKey,
    agentName,
    item,
    isConnected,
    catalogFailed,
    catalogLoading,
    unavailable,
    agentMissing,
    isAuthorized,
    permissionLoading,
    connectModalOpen,
  };
}

function DirectedAuthorizeReadError() {
  const { t } = useTranslation();
  return (
    <DirectedCardShell
      icon={<CircleAlert size={20} />}
      title={t(($) => {
        return $.connectors.accounts.accountsUnavailable;
      })}
      description=""
      isLoading={false}
    >
      {null}
    </DirectedCardShell>
  );
}

function DirectedAuthorizeCard() {
  const { t } = useTranslation();
  const {
    params,
    authorizeLoadable,
    authorize,
    completeAuthorization,
    actionCallback,
    signal,
    setModalKey,
    agentName,
    item,
    isConnected,
    catalogFailed,
    catalogLoading,
    unavailable,
    agentMissing,
    isAuthorized,
    permissionLoading,
    connectModalOpen,
  } = useDirectedAuthorizeCardState();
  if (catalogFailed) {
    return <DirectedAuthorizeReadError />;
  }
  if (!params || unavailable) {
    return null;
  }
  const { connectorSlug, agentId } = params;
  const isConnecting = authorizeLoadable.state === "loading";
  const canAuthorize =
    isConnected || (item ? item.authMethods.length > 0 : false);
  const completedAuthorization =
    isAuthorized && authorizeLoadable.state !== "hasError";
  const handleAuthorizeSuccess: ConnectorConnectSuccess = (
    _connectionId,
    attemptSignal,
  ) => {
    return completeAuthorization(agentId, actionCallback, attemptSignal);
  };
  return (
    <>
      <DirectedCardShell
        icon={<ConnectorIcon icon={item?.icon} size={20} />}
        title={directedAuthorizeTitle(
          t,
          agentMissing,
          completedAuthorization,
          item?.label ?? connectorSlug,
          agentName,
        )}
        description={item?.description ?? ""}
        isLoading={catalogLoading || permissionLoading}
      >
        <div className="flex items-center justify-center">
          {!agentMissing && (
            <AuthorizeAction
              isAuthorized={completedAuthorization}
              isConnecting={isConnecting}
              disabled={!canAuthorize}
              agentName={agentName}
              onAuthorize={() => {
                if (canAuthorize) {
                  detach(
                    authorize(
                      { connectorSlug, agentId, item, isConnected },
                      signal,
                    ),
                    Reason.DomCallback,
                  );
                }
              }}
            />
          )}
        </div>
        <DirectedActionError loadable={authorizeLoadable} />
      </DirectedCardShell>
      <DirectedAuthorizeConnectModal
        open={connectModalOpen}
        item={item}
        agentId={agentId}
        onSuccess={handleAuthorizeSuccess}
        close={() => {
          return setModalKey(null, signal);
        }}
      />
    </>
  );
}

export function DirectedAuthorizePage() {
  return <DirectedAuthorizeCard />;
}
