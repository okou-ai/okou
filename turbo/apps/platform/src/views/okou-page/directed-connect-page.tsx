import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { Button } from "@okouai/ui";
import {
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogAuthMethodDetail } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import type {
  CustomConnectorResponse,
  CustomConnectorSlug,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  PlatformConnectorAccountMutationIntent,
  PlatformConnectorCatalogStatusItem,
} from "../../signals/connector-domain.ts";
import { Input } from "@okouai/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  connectBuiltinConnectorOAuthAuthCode$,
  type ConnectorConnectSuccess,
  connectBuiltinConnectorNoAuth$,
  builtinConnectFlowSlug$,
  getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail,
  getOnlyAvailableBuiltinConnectorStatusNoAuthMethod,
  getBuiltinConnectorStatusConnectLaunchMode,
  justConnectedBuiltinSlugs$,
  builtinPollingOAuthAuthCodeSlug$,
  builtinPollingOAuthDeviceAuthSlug$,
  submitBuiltinManualGrant$,
  builtinManualGrantFormSubmitting$,
  setBuiltinManualGrantFormValue$,
  builtinManualGrantFormValuesFor$,
  setBuiltinManualGrantFormSubmitting$,
  getOnlyManualBuiltinConnectorStatusAuthMethod,
  hasBuiltinConnectorStatusProviderDrivenConnectMethod,
  manualGrantInputValuesForMethod,
  type BuiltinConnectorConnectionResult,
} from "../../signals/okou-page/settings/connectors.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import { hasTokenInputValue } from "../../signals/okou-page/settings/token-input.ts";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
  withCleanup,
} from "../../signals/utils.ts";
import {
  directedConnectSlug$,
  directedConnectCustomSlug$,
  directedConnectAccountTarget$,
  directedConnectExactAccount$,
  directedConnectAgentId$,
  directedConnectAgentName$,
  manualGrantDialogKey$,
  setManualGrantDialogKey$,
  directedConnectModalKey$,
  setDirectedConnectModalKey$,
  directedConnectCustomDialogKey$,
  setDirectedConnectCustomDialogKey$,
} from "../../signals/connectors-page/directed-connect-slug.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { Check, Loader2 } from "lucide-react";
import { DirectedCardShell } from "./directed-shared.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import type { FormEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { assistantName$ } from "../../signals/branding.ts";
import { ConnectorHelpText } from "./components/settings/connector-help-text.tsx";
import {
  routeChatActionCallback$,
  runChatActionCallback$,
} from "../../signals/chat-page/action-callback.ts";
import {
  customConnectors$,
  resetCustomConnectorConnectInput$,
} from "../../signals/okou-page/settings/custom-connectors.ts";
import { CustomConnectorIcon } from "./components/settings/custom-connector-icon.tsx";
import { CustomConnectorConnectDialog } from "./components/settings/custom-connector-connect-dialog.tsx";
import { customConnectorTarget } from "./components/settings/custom-connector-display.ts";
import {
  defaultBuiltinConnectorAccountOptions,
  defaultCustomConnectorAccountOptions,
  type ConnectorAccountMutationOptions,
  type DefaultConnectorAccountMutationOptions,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";

function runDirectedConnect(
  params: {
    item: PlatformConnectorCatalogStatusItem;
    connectorSlug: ConnectorSlug;
    agentId: string | null;
    accountOptions: ConnectorAccountMutationOptions;
    connect: (
      connectorSlug: ConnectorSlug,
      method: PublicConnectorCatalogAuthMethodDetail,
      options: {
        readonly connectorLabel?: string;
        readonly connectorIcon: PlatformConnectorCatalogStatusItem["icon"];
        readonly onSuccess?: ConnectorConnectSuccess;
        readonly agentId?: string;
        readonly account: PlatformConnectorAccountMutationIntent;
        readonly useDefaultConnectorProjection?: boolean;
        readonly authorizeVisibleAgents?: boolean;
      },
      signal: AbortSignal,
    ) => Promise<BuiltinConnectorConnectionResult | false>;
    connectNoAuth: (
      args: {
        readonly connectorSlug: ConnectorSlug;
        readonly authMethod: ConnectorAuthMethodId;
        readonly options: {
          readonly connectorLabel?: string;
          readonly agentId?: string;
          readonly account: PlatformConnectorAccountMutationIntent;
          readonly useDefaultConnectorProjection?: boolean;
          readonly authorizeVisibleAgents?: boolean;
        };
      },
      signal: AbortSignal,
    ) => Promise<BuiltinConnectorConnectionResult | false>;
    openConnectModal: () => void;
    openManualGrantDialog: () => void;
    onSuccess: ConnectorConnectSuccess;
  },
  signal: AbortSignal,
): void {
  const launchMode = getBuiltinConnectorStatusConnectLaunchMode(params.item);
  if (
    launchMode === "modal" &&
    hasBuiltinConnectorStatusProviderDrivenConnectMethod(params.item)
  ) {
    params.openConnectModal();
    return;
  }

  const manualGrantMethod = getOnlyManualBuiltinConnectorStatusAuthMethod(
    params.item,
  );

  if (
    launchMode === "modal" &&
    manualGrantMethod &&
    params.item.authMethods.length === 1
  ) {
    params.openManualGrantDialog();
    return;
  }
  if (launchMode === "modal") {
    params.openConnectModal();
    return;
  }

  detach(
    (async () => {
      if (launchMode === "browser-auth") {
        const authMethod =
          getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail(
            params.item,
          );
        if (!authMethod) {
          params.openConnectModal();
          return;
        }
        await params.connect(
          params.connectorSlug,
          authMethod,
          {
            connectorLabel: params.item.label,
            connectorIcon: params.item.icon,
            ...(params.agentId
              ? { agentId: params.agentId }
              : { authorizeVisibleAgents: true }),
            ...params.accountOptions,
            onSuccess: params.onSuccess,
          },
          signal,
        );
      } else {
        const authMethod = getOnlyAvailableBuiltinConnectorStatusNoAuthMethod(
          params.item,
        );
        if (!authMethod) {
          params.openConnectModal();
          return;
        }
        const connected = await params.connectNoAuth(
          {
            connectorSlug: params.connectorSlug,
            authMethod,
            options: {
              connectorLabel: params.item.label,
              ...(params.agentId
                ? { agentId: params.agentId }
                : { authorizeVisibleAgents: true }),
              ...params.accountOptions,
            },
          },
          signal,
        );
        if (connected) {
          await params.onSuccess(connected.connectionId, signal);
        }
      }
    })(),
    Reason.DomCallback,
  );
}

function ManualGrantForm({
  connectorSlug,
  agentId,
  connectorLabel,
  manualGrantMethod,
  accountOptions,
  onSuccess,
}: {
  connectorSlug: ConnectorSlug;
  agentId: string | null;
  connectorLabel: string;
  manualGrantMethod: PublicConnectorCatalogAuthMethodDetail;
  accountOptions: ConnectorAccountMutationOptions;
  onSuccess: ConnectorConnectSuccess;
}) {
  const { t } = useTranslation();
  const submit = useSet(submitBuiltinManualGrant$);
  const setFormValue = useSet(setBuiltinManualGrantFormValue$);
  const pageSignal = useGet(pageSignal$);
  const manualGrantFormValuesFor = useGet(builtinManualGrantFormValuesFor$);
  const fieldValues = manualGrantFormValuesFor(connectorSlug);
  const submittingSlug = useGet(builtinManualGrantFormSubmitting$);
  const setSubmitting = useSet(setBuiltinManualGrantFormSubmitting$);
  const submitting = submittingSlug === connectorSlug;

  const allFilled = manualGrantMethod.manualFields.every((field) => {
    return !field.required || hasTokenInputValue(fieldValues[field.id]);
  });

  const handleSubmit = onDomEventFn(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!allFilled || submitting) {
        return;
      }
      setSubmitting(connectorSlug);
      await withCleanup(
        bestEffort(
          (async () => {
            const connected = await submit(
              {
                connectorSlug,
                authMethod: manualGrantMethod.id,
                inputValues: manualGrantInputValuesForMethod(
                  manualGrantMethod,
                  fieldValues,
                ),
                options: {
                  connectorLabel,
                  ...(agentId ? { agentId } : { authorizeVisibleAgents: true }),
                  ...accountOptions,
                },
              },
              pageSignal,
            );
            if (!connected) {
              return;
            }
            await onSuccess(connected.connectionId, pageSignal);
          })(),
        ),
        () => {
          setSubmitting(null);
        },
      );
    },
  );

  return (
    <form
      className="flex w-full flex-col gap-3 text-left"
      onSubmit={handleSubmit}
    >
      {manualGrantMethod.description && (
        <ConnectorHelpText text={manualGrantMethod.description} />
      )}
      {manualGrantMethod.manualFields.map((fieldConfig) => {
        return (
          <div key={fieldConfig.id} className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {fieldConfig.label}
            </label>
            <Input
              type={fieldConfig.inputType}
              placeholder={fieldConfig.placeholder ?? undefined}
              value={fieldValues[fieldConfig.id] ?? ""}
              onChange={(e) => {
                return setFormValue(
                  connectorSlug,
                  fieldConfig.id,
                  e.target.value,
                );
              }}
            />
          </div>
        );
      })}
      <Button
        type="submit"
        disabled={!allFilled || submitting}
        className="w-full px-0 disabled:opacity-60"
      >
        {submitting && <Loader2 size={14} className="animate-spin" />}
        {submitting
          ? t(($) => {
              return $.connectors.actions.saving;
            })
          : t(($) => {
              return $.connectors.actions.save;
            })}
      </Button>
    </form>
  );
}

function ManualGrantDialog({
  connectorSlug,
  agentId,
  icon,
  connectorLabel,
  manualGrantMethod,
  accountOptions,
  open,
  onOpenChange,
  onSuccess,
}: {
  connectorSlug: ConnectorSlug;
  agentId: string | null;
  icon: PlatformConnectorCatalogStatusItem["icon"] | undefined;
  connectorLabel: string;
  manualGrantMethod: PublicConnectorCatalogAuthMethodDetail | null;
  accountOptions: ConnectorAccountMutationOptions | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: ConnectorConnectSuccess;
}) {
  if (!manualGrantMethod || !accountOptions) {
    return null;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent maxWidth="md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon icon={icon} size={20} />
            <DialogTitle>{connectorLabel}</DialogTitle>
          </div>
        </DialogHeader>
        <ManualGrantForm
          connectorSlug={connectorSlug}
          agentId={agentId}
          connectorLabel={connectorLabel}
          manualGrantMethod={manualGrantMethod}
          accountOptions={accountOptions}
          onSuccess={async (connectionId, signal) => {
            await onSuccess(connectionId, signal);
            signal.throwIfAborted();
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConnectActions({
  isConnected,
  isConnecting,
  disabled,
  onConnect,
}: {
  isConnected: boolean;
  isConnecting: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  if (isConnected) {
    return (
      <>
        <div className="inline-flex h-9 w-[100px] items-center justify-center gap-1.5 text-sm font-medium text-emerald-600">
          <Check size={16} />
          {t(($) => {
            return $.connectors.card.connected;
          })}
        </div>
        <Button
          type="button"
          variant="link"
          size="xs"
          disabled={isConnecting || disabled}
          onClick={onConnect}
          className="h-auto gap-1.5 px-0 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
        >
          {isConnecting && <Loader2 size={12} className="animate-spin" />}
          {isConnecting
            ? t(($) => {
                return $.connectors.directed.reconnecting;
              })
            : t(($) => {
                return $.connectors.actions.reconnect;
              })}
        </Button>
      </>
    );
  }
  return (
    <Button
      type="button"
      disabled={isConnecting || disabled}
      onClick={onConnect}
      className="w-[100px] px-0 disabled:opacity-60"
    >
      {isConnecting && <Loader2 size={14} className="animate-spin" />}
      {isConnecting
        ? t(($) => {
            return $.connectors.actions.connecting;
          })
        : t(($) => {
            return $.connectors.actions.connect;
          })}
    </Button>
  );
}

function DirectedConnectModal({
  open,
  item,
  accountOptions,
  reconnectAuthMethod,
  agentId,
  onClose,
  onSuccess,
}: {
  readonly open: boolean;
  readonly item: PlatformConnectorCatalogStatusItem | undefined;
  readonly accountOptions: ConnectorAccountMutationOptions | null;
  readonly reconnectAuthMethod: ConnectorAuthMethodId | undefined;
  readonly agentId: string | null;
  readonly onClose: () => void;
  readonly onSuccess: ConnectorConnectSuccess;
}) {
  if (!open || !item || !accountOptions) {
    return null;
  }
  return (
    <ConnectModal
      item={item}
      {...(agentId ? { agentId } : {})}
      accountOptions={accountOptions}
      reconnectAuthMethod={reconnectAuthMethod}
      authorizeVisibleAgentsOnConnect={!agentId}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}

function DirectedConnectDialogs({
  connectorSlug,
  item,
  accountOptions,
  reconnectAuthMethod,
  icon,
  connectorLabel,
  manualGrantMethod,
  manualGrantDialogOpen,
  setManualGrantDialogOpen,
  agentId,
  connectModalOpen,
  setConnectModalOpen,
  onSuccess,
}: {
  readonly connectorSlug: ConnectorSlug;
  readonly item: PlatformConnectorCatalogStatusItem | undefined;
  readonly accountOptions: ConnectorAccountMutationOptions | null;
  readonly reconnectAuthMethod: ConnectorAuthMethodId | undefined;
  readonly icon: PlatformConnectorCatalogStatusItem["icon"] | undefined;
  readonly connectorLabel: string;
  readonly manualGrantMethod: PublicConnectorCatalogAuthMethodDetail | null;
  readonly manualGrantDialogOpen: boolean;
  readonly setManualGrantDialogOpen: (open: boolean) => void;
  readonly agentId: string | null | undefined;
  readonly connectModalOpen: boolean;
  readonly setConnectModalOpen: (open: boolean) => void;
  readonly onSuccess: ConnectorConnectSuccess;
}) {
  return (
    <>
      <ManualGrantDialog
        connectorSlug={connectorSlug}
        agentId={agentId ?? null}
        icon={icon}
        connectorLabel={connectorLabel}
        manualGrantMethod={manualGrantMethod}
        accountOptions={accountOptions}
        open={manualGrantDialogOpen}
        onOpenChange={setManualGrantDialogOpen}
        onSuccess={onSuccess}
      />
      <DirectedConnectModal
        open={connectModalOpen}
        item={item}
        accountOptions={accountOptions}
        reconnectAuthMethod={reconnectAuthMethod}
        agentId={agentId ?? null}
        onClose={() => {
          setConnectModalOpen(false);
        }}
        onSuccess={onSuccess}
      />
    </>
  );
}

function useDirectedConnectConnectorSlug(): ConnectorSlug | null {
  const connectorSlug = useGet(directedConnectSlug$);
  if (!connectorSlug) {
    return null;
  }
  const parsed = connectorSlugSchema.safeParse(connectorSlug);
  return parsed.success ? parsed.data : null;
}

interface DirectedConnectCatalogState {
  readonly item: PlatformConnectorCatalogStatusItem | undefined;
  readonly isConnected: boolean;
  readonly isLoading: boolean;
  readonly unavailable: boolean;
}

function useDirectedConnectCatalogState(
  connectorSlug: ConnectorSlug | null,
): DirectedConnectCatalogState {
  const justConnected = useGet(justConnectedBuiltinSlugs$);
  const allLoadable = useLastLoadable(connectorCatalogStatus$);
  const catalogLoaded = allLoadable.state === "hasData";
  const allData = catalogLoaded ? allLoadable.data.connectors : [];
  const item = connectorSlug
    ? allData.find((connector) => {
        return connector.slug === connectorSlug;
      })
    : undefined;
  const optimisticallyConnected =
    connectorSlug !== null && justConnected.has(connectorSlug);
  const isConnected = optimisticallyConnected || (item?.connected ?? false);
  return {
    item,
    isConnected,
    isLoading:
      connectorSlug !== null &&
      !optimisticallyConnected &&
      allLoadable.state === "loading",
    unavailable:
      connectorSlug !== null &&
      catalogLoaded &&
      !item &&
      !optimisticallyConnected,
  };
}

type DirectedConnectAccountState =
  | { readonly kind: "default" }
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "exact";
      readonly account: ConnectorAccountConnection;
    };

function useDirectedConnectAccountState(): DirectedConnectAccountState {
  const target = useGet(directedConnectAccountTarget$);
  const accountLoadable = useLastLoadable(directedConnectExactAccount$);
  if (target.kind === "default") {
    return target;
  }
  if (target.kind === "invalid") {
    return { kind: "unavailable" };
  }
  if (accountLoadable.state === "loading") {
    return { kind: "loading" };
  }
  if (accountLoadable.state === "hasData" && accountLoadable.data) {
    return { kind: "exact", account: accountLoadable.data };
  }
  return { kind: "unavailable" };
}

interface DirectedConnectPresentation {
  readonly accountOptions: ConnectorAccountMutationOptions | null;
  readonly reconnectAuthMethod: ConnectorAuthMethodId | undefined;
  readonly isConnected: boolean;
  readonly isLoading: boolean;
  readonly unavailable: boolean;
}

function directedConnectPresentation(args: {
  readonly accountState: DirectedConnectAccountState;
  readonly catalogState: DirectedConnectCatalogState;
}): DirectedConnectPresentation {
  const { accountState, catalogState } = args;
  if (catalogState.unavailable || accountState.kind === "unavailable") {
    return {
      accountOptions: null,
      reconnectAuthMethod: undefined,
      isConnected: false,
      isLoading: false,
      unavailable: true,
    };
  }
  if (accountState.kind === "loading") {
    return {
      accountOptions: null,
      reconnectAuthMethod: undefined,
      isConnected: catalogState.isConnected,
      isLoading: true,
      unavailable: false,
    };
  }
  if (accountState.kind === "exact") {
    return {
      accountOptions: {
        account: {
          intent: "reconnect",
          connectionId: accountState.account.id,
        },
      },
      reconnectAuthMethod: accountState.account.authMethod,
      isConnected: true,
      isLoading: catalogState.isLoading,
      unavailable: false,
    };
  }
  const accountOptions = defaultBuiltinConnectorAccountOptions(
    catalogState.item,
  );
  return {
    accountOptions,
    reconnectAuthMethod:
      accountOptions?.account.intent === "reconnect"
        ? catalogState.item?.connection?.authMethod
        : undefined,
    isConnected: catalogState.isConnected,
    isLoading: catalogState.isLoading,
    unavailable: false,
  };
}

function useDirectedConnectPresentation(connectorSlug: ConnectorSlug | null): {
  readonly item: PlatformConnectorCatalogStatusItem | undefined;
  readonly presentation: DirectedConnectPresentation;
} {
  const accountState = useDirectedConnectAccountState();
  const catalogState = useDirectedConnectCatalogState(connectorSlug);
  return {
    item: catalogState.item,
    presentation: directedConnectPresentation({ accountState, catalogState }),
  };
}

function useDirectedConnectDialogOpenState(
  connectorSlug: ConnectorSlug | null,
  agentId: string | null,
  signal: AbortSignal,
): {
  readonly manualGrantDialogOpen: boolean;
  readonly connectModalOpen: boolean;
} {
  const manualGrantDialogKey = useGet(manualGrantDialogKey$);
  const connectModalKey = useGet(directedConnectModalKey$);
  return {
    manualGrantDialogOpen:
      manualGrantDialogKey?.connectorSlug === connectorSlug &&
      manualGrantDialogKey.agentId === agentId &&
      manualGrantDialogKey.signal === signal,
    connectModalOpen:
      connectModalKey?.connectorSlug === connectorSlug &&
      connectModalKey.agentId === agentId &&
      connectModalKey.signal === signal,
  };
}

function DirectedConnectCardContent({
  icon,
  connectorLabel,
  connectorDescription,
  agentName,
  isLoading,
  isConnected,
  isConnecting,
  canConnect,
  onConnect,
}: {
  readonly icon: ReactNode;
  readonly connectorLabel: string;
  readonly connectorDescription: string;
  readonly agentName: string;
  readonly isLoading: boolean;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly canConnect: boolean;
  readonly onConnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DirectedCardShell
      icon={icon}
      title={
        isConnected
          ? t(
              ($) => {
                return $.connectors.directed.connected;
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
      <div className="flex flex-col items-center justify-center gap-2">
        <ConnectActions
          isConnected={isConnected}
          isConnecting={isConnecting}
          disabled={!canConnect}
          onConnect={onConnect}
        />
      </div>
    </DirectedCardShell>
  );
}

function DirectedConnectCard() {
  const connectorSlug = useDirectedConnectConnectorSlug();
  const assistantName = useGet(assistantName$);
  const agentId = useGet(directedConnectAgentId$);
  const agentNameLoadable = useLastLoadable(directedConnectAgentName$);
  const pollingAuthCodeSlug = useGet(builtinPollingOAuthAuthCodeSlug$);
  const pollingDeviceAuthSlug = useGet(builtinPollingOAuthDeviceAuthSlug$);
  const connectFlowSlug = useGet(builtinConnectFlowSlug$);
  const connect = useSet(connectBuiltinConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectBuiltinConnectorNoAuth$);
  const signal = useGet(pageSignal$);
  const { item, presentation } = useDirectedConnectPresentation(connectorSlug);
  const setManualGrantDialogKey = useSet(setManualGrantDialogKey$);
  const setDirectedConnectModalKey = useSet(setDirectedConnectModalKey$);
  const actionCallback = useGet(routeChatActionCallback$);
  const runCallback = useSet(runChatActionCallback$);
  const { manualGrantDialogOpen, connectModalOpen } =
    useDirectedConnectDialogOpenState(connectorSlug, agentId, signal);

  if (!connectorSlug) {
    return null;
  }

  const agentName =
    agentNameLoadable.state === "hasData" &&
    agentNameLoadable.data.agentId === agentId &&
    agentNameLoadable.data.displayName
      ? agentNameLoadable.data.displayName
      : assistantName;
  const isConnecting =
    pollingAuthCodeSlug === connectorSlug ||
    pollingDeviceAuthSlug === connectorSlug ||
    connectFlowSlug === connectorSlug;
  if (presentation.unavailable) {
    return null;
  }
  const authMethods = item?.authMethods ?? [];
  const { accountOptions, reconnectAuthMethod, isConnected, isLoading } =
    presentation;
  const manualGrantMethod = item
    ? getOnlyManualBuiltinConnectorStatusAuthMethod(item)
    : null;
  const canConnect = authMethods.length > 0 && accountOptions !== null;
  const connectorLabel = item?.label ?? connectorSlug;
  const connectorDescription = item?.description ?? "";
  const handleConnectSuccess: ConnectorConnectSuccess = async (
    _connectionId,
    attemptSignal,
  ) => {
    if (actionCallback.callbackPrompt && actionCallback.threadId && agentId) {
      await runCallback(
        {
          threadId: actionCallback.threadId,
          agentId,
          callbackPrompt: actionCallback.callbackPrompt,
        },
        attemptSignal,
      );
    }
  };

  const handleConnect = () => {
    if (!canConnect || !item) {
      return;
    }
    runDirectedConnect(
      {
        item,
        connectorSlug,
        agentId,
        accountOptions,
        connect,
        connectNoAuth,
        openManualGrantDialog: () => {
          return setManualGrantDialogKey({
            connectorSlug,
            agentId,
            signal,
          });
        },
        openConnectModal: () => {
          setDirectedConnectModalKey({
            connectorSlug,
            agentId,
            signal,
          });
        },
        onSuccess: handleConnectSuccess,
      },
      signal,
    );
  };

  return (
    <>
      <DirectedConnectCardContent
        icon={<ConnectorIcon icon={item?.icon} size={20} />}
        connectorLabel={connectorLabel}
        connectorDescription={connectorDescription}
        agentName={agentName}
        isLoading={isLoading}
        isConnected={isConnected}
        isConnecting={isConnecting}
        canConnect={canConnect}
        onConnect={handleConnect}
      />
      <DirectedConnectDialogs
        connectorSlug={connectorSlug}
        item={item}
        accountOptions={accountOptions}
        reconnectAuthMethod={reconnectAuthMethod}
        icon={item?.icon}
        connectorLabel={connectorLabel}
        manualGrantMethod={manualGrantMethod}
        manualGrantDialogOpen={manualGrantDialogOpen}
        setManualGrantDialogOpen={(open) => {
          setManualGrantDialogKey(
            open ? { connectorSlug, agentId, signal } : null,
          );
        }}
        agentId={agentId}
        connectModalOpen={connectModalOpen}
        setConnectModalOpen={(open) => {
          setDirectedConnectModalKey(
            open ? { connectorSlug, agentId, signal } : null,
          );
        }}
        onSuccess={handleConnectSuccess}
      />
    </>
  );
}

function customConnectorForSlug(
  connectors: readonly CustomConnectorResponse[],
  connectorSlug: CustomConnectorSlug,
): CustomConnectorResponse | undefined {
  return connectors.find((connector) => {
    return connector.slug === connectorSlug;
  });
}

interface CustomConnectorConnection {
  readonly connector: CustomConnectorResponse;
  readonly accountOptions: DefaultConnectorAccountMutationOptions;
}

function customConnectorConnection(
  connector: CustomConnectorResponse | undefined,
): CustomConnectorConnection | null {
  const accountOptions = defaultCustomConnectorAccountOptions(connector);
  return connector && accountOptions ? { connector, accountOptions } : null;
}

function CustomDirectedConnectorDialog({
  connection,
  open,
  agentId,
  onClose,
  onSuccess,
}: {
  readonly connection: CustomConnectorConnection | null;
  readonly open: boolean;
  readonly agentId: string | null;
  readonly onClose: () => void;
  readonly onSuccess: ConnectorConnectSuccess;
}) {
  if (!connection || !open) {
    return null;
  }
  return (
    <CustomConnectorConnectDialog
      connector={connection.connector}
      {...(agentId ? { agentId } : {})}
      accountOptions={connection.accountOptions}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}

function CustomDirectedConnectCard({
  connectorSlug,
}: {
  readonly connectorSlug: CustomConnectorSlug;
}) {
  const assistantName = useGet(assistantName$);
  const agentId = useGet(directedConnectAgentId$);
  const agentNameLoadable = useLastLoadable(directedConnectAgentName$);
  const connectorsLoadable = useLastLoadable(customConnectors$);
  const dialogKey = useGet(directedConnectCustomDialogKey$);
  const setDialogKey = useSet(setDirectedConnectCustomDialogKey$);
  const resetConnectInput = useSet(resetCustomConnectorConnectInput$);
  const actionCallback = useGet(routeChatActionCallback$);
  const runCallback = useSet(runChatActionCallback$);
  const signal = useGet(pageSignal$);
  const connectors =
    connectorsLoadable.state === "hasData" ? connectorsLoadable.data : [];
  const connector = customConnectorForSlug(connectors, connectorSlug);
  const connection = customConnectorConnection(connector);
  const dialogOpen =
    dialogKey?.connectorSlug === connectorSlug &&
    dialogKey.agentId === agentId &&
    dialogKey.signal === signal;

  if (connectorsLoadable.state === "hasData" && !connector) {
    return null;
  }

  const agentName =
    agentNameLoadable.state === "hasData" &&
    agentNameLoadable.data.agentId === agentId &&
    agentNameLoadable.data.displayName
      ? agentNameLoadable.data.displayName
      : assistantName;
  const handleConnectSuccess: ConnectorConnectSuccess = async (
    _connectionId,
    attemptSignal,
  ) => {
    if (actionCallback.callbackPrompt && actionCallback.threadId && agentId) {
      await runCallback(
        {
          threadId: actionCallback.threadId,
          agentId,
          callbackPrompt: actionCallback.callbackPrompt,
        },
        attemptSignal,
      );
    }
  };
  const setDialogOpen = (open: boolean) => {
    setDialogKey(open ? { connectorSlug, agentId, signal } : null);
  };

  return (
    <>
      <DirectedConnectCardContent
        icon={
          connector ? (
            <CustomConnectorIcon
              id={connector.id}
              displayName={connector.displayName}
              size={20}
            />
          ) : null
        }
        connectorLabel={connector?.displayName ?? connectorSlug}
        connectorDescription={connector ? customConnectorTarget(connector) : ""}
        agentName={agentName}
        isLoading={connectorsLoadable.state === "loading"}
        isConnected={connector?.connected ?? false}
        isConnecting={false}
        canConnect={connection !== null}
        onConnect={() => {
          if (!connection) {
            return;
          }
          resetConnectInput();
          setDialogOpen(true);
        }}
      />
      <CustomDirectedConnectorDialog
        connection={connection}
        open={dialogOpen}
        agentId={agentId}
        onClose={() => {
          setDialogOpen(false);
        }}
        onSuccess={handleConnectSuccess}
      />
    </>
  );
}

export function DirectedConnectPage() {
  const customConnectorSlug = useGet(directedConnectCustomSlug$);
  const accountTarget = useGet(directedConnectAccountTarget$);
  if (customConnectorSlug && accountTarget.kind !== "default") {
    return null;
  }
  return customConnectorSlug ? (
    <CustomDirectedConnectCard connectorSlug={customConnectorSlug} />
  ) : (
    <DirectedConnectCard />
  );
}
