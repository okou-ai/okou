import { useLoadable, useGet, useSet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button, LoadErrorRow } from "@okouai/ui";
import {
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogAuthMethodDetail } from "@okouai/api-contracts/contracts/connector-catalog";
import type {
  CustomConnectorSlug,
  CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import { withMemberAccount } from "../../signals/external/connectors.ts";
import { Input } from "@okouai/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  type ConnectorConnectSuccess,
  builtinConnectOperation$,
  justConnectedBuiltinSlugs$,
  builtinPollingOAuthAuthCodeSlug$,
  builtinPollingOAuthDeviceAuthSlug$,
  submitBuiltinManualGrantAndSettle$,
  setBuiltinManualGrantFormValue$,
  builtinManualGrantFormValuesFor$,
  getOnlyManualBuiltinConnectorStatusAuthMethod,
  manualGrantInputValuesForMethod,
} from "../../signals/okou-page/settings/connectors.ts";
import { hasTokenInputValue } from "../../signals/okou-page/settings/token-input.ts";
import { detach, onDomEventFn, Reason } from "../../signals/utils.ts";
import {
  connectDirectedConnector$,
  directedConnectSlug$,
  directedConnectCustomSlug$,
  directedConnectCustomConnected$,
  directedConnectAccountTarget$,
  directedConnectCatalogItem$,
  directedConnectExactAccount$,
  directedConnectAccounts$,
  reloadDirectedConnectAccounts$,
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
import { DirectedActionError, DirectedCardShell } from "./directed-shared.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import type { FormEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { assistantName$ } from "../../signals/branding.ts";
import { ConnectorHelpText } from "./components/settings/connector-help-text.tsx";
import { completeDirectedConnectorAction$ } from "../../signals/connectors-page/directed-connector-callback.ts";
import { routeChatActionCallback$ } from "../../signals/chat-page/action-callback.ts";
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
  type CustomConnectorAccountMutationOptions,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";

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
  const [submitLoadable, submit] = useLoadableSet(
    submitBuiltinManualGrantAndSettle$,
  );
  const setFormValue = useSet(setBuiltinManualGrantFormValue$);
  const pageSignal = useGet(pageSignal$);
  const manualGrantFormValuesFor = useGet(builtinManualGrantFormValuesFor$);
  const fieldValues = manualGrantFormValuesFor(connectorSlug);
  const submitting = submitLoadable.state === "loading";

  const allFilled = manualGrantMethod.manualFields.every((field) => {
    return !field.required || hasTokenInputValue(fieldValues[field.id]);
  });

  const handleSubmit = onDomEventFn(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!allFilled || submitting) {
        return;
      }
      await submit(
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
          onSuccess,
        },
        pageSignal,
      );
    },
  );

  return (
    <form
      className="flex w-full flex-col gap-3 text-left"
      onSubmit={handleSubmit}
    >
      {submitLoadable.state === "hasError" && (
        <p role="alert" className="text-sm text-destructive">
          {String(submitLoadable.error)}
        </p>
      )}
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
  const itemLoadable = useLastLoadable(directedConnectCatalogItem$);
  // The last entry is kept across a reload, never shown for another slug.
  const catalogLoaded =
    itemLoadable.state === "hasData" &&
    (itemLoadable.data === null || itemLoadable.data.slug === connectorSlug);
  const item =
    catalogLoaded && connectorSlug
      ? (itemLoadable.data ?? undefined)
      : undefined;
  const optimisticallyConnected =
    connectorSlug !== null && justConnected.has(connectorSlug);
  const isConnected = optimisticallyConnected || (item?.connected ?? false);
  return {
    item,
    isConnected,
    isLoading:
      connectorSlug !== null && !optimisticallyConnected && !catalogLoaded,
    unavailable:
      connectorSlug !== null &&
      catalogLoaded &&
      !item &&
      !optimisticallyConnected,
  };
}

type DirectedConnectAccountState =
  | {
      readonly kind: "default";
      readonly account: ConnectorAccountConnection | null;
    }
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "exact";
      readonly account: ConnectorAccountConnection;
    };

function useDirectedConnectAccountState(): DirectedConnectAccountState {
  const target = useGet(directedConnectAccountTarget$);
  const accountLoadable = useLastLoadable(directedConnectExactAccount$);
  const accountsLoadable = useLastLoadable(directedConnectAccounts$);
  if (target.kind === "default") {
    if (accountsLoadable.state === "loading") {
      return { kind: "loading" };
    }
    return accountsLoadable.state === "hasData" &&
      accountsLoadable.data.available
      ? {
          kind: "default",
          account: accountsLoadable.data.defaultConnection,
        }
      : { kind: "unavailable" };
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
  const account =
    accountState.kind === "default" ? accountState.account : undefined;
  const item =
    catalogState.item && account !== undefined
      ? withMemberAccount(catalogState.item, account)
      : catalogState.item;
  const isConnected =
    account !== undefined
      ? (item?.connected ?? false)
      : catalogState.isConnected;
  return {
    item,
    presentation: directedConnectPresentation({
      accountState,
      catalogState: { ...catalogState, item, isConnected },
    }),
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
  const connectOperation = useLoadable(builtinConnectOperation$);
  const [connectLoadable, connect] = useLoadableSet(connectDirectedConnector$);
  const signal = useGet(pageSignal$);
  const { item, presentation } = useDirectedConnectPresentation(connectorSlug);
  const setManualGrantDialogKey = useSet(setManualGrantDialogKey$);
  const setDirectedConnectModalKey = useSet(setDirectedConnectModalKey$);
  const completeAction = useSet(completeDirectedConnectorAction$);
  const reloadAccounts = useSet(reloadDirectedConnectAccounts$);
  const actionCallback = useGet(routeChatActionCallback$);
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
    connectOperation.state === "loading" ||
    connectLoadable.state === "loading";
  if (presentation.unavailable) {
    return (
      <DirectedConnectAccountsError item={item} connectorSlug={connectorSlug} />
    );
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
  const handleConnectSuccess: ConnectorConnectSuccess = (
    _connectionId,
    attemptSignal,
  ) => {
    reloadAccounts(attemptSignal);
    return completeAction(agentId, actionCallback, attemptSignal);
  };

  const handleConnect = () => {
    if (!canConnect || !item) {
      return;
    }
    detach(connect(item, agentId, accountOptions, signal), Reason.DomCallback);
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
      <DirectedActionError loadable={connectLoadable} />
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
            open ? { connectorSlug, agentId } : null,
            signal,
          );
        }}
        agentId={agentId}
        connectModalOpen={connectModalOpen}
        setConnectModalOpen={(open) => {
          setDirectedConnectModalKey(
            open ? { connectorSlug, agentId } : null,
            signal,
          );
        }}
        onSuccess={handleConnectSuccess}
      />
    </>
  );
}

function DirectedConnectAccountsError({
  item,
  connectorSlug,
}: {
  readonly item: PlatformConnectorCatalogStatusItem | undefined;
  readonly connectorSlug: ConnectorSlug;
}) {
  const { t } = useTranslation();
  const accounts = useLastLoadable(directedConnectAccounts$);
  const reloadAccounts = useSet(reloadDirectedConnectAccounts$);
  const signal = useGet(pageSignal$);
  if (accounts.state !== "hasError") {
    return null;
  }
  return (
    <DirectedCardShell
      icon={<ConnectorIcon icon={item?.icon} size={20} />}
      title={item?.label ?? connectorSlug}
      description={item?.description ?? ""}
      isLoading={false}
    >
      <LoadErrorRow
        message={t(($) => {
          return $.connectors.accounts.accountsUnavailable;
        })}
        retryLabel={t(($) => {
          return $.global.actions.tryAgain;
        })}
        onRetry={() => {
          reloadAccounts(signal);
        }}
      />
    </DirectedCardShell>
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
  readonly accountOptions: CustomConnectorAccountMutationOptions;
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
  const connectedLoadable = useLastLoadable(directedConnectCustomConnected$);
  const dialogKey = useGet(directedConnectCustomDialogKey$);
  const setDialogKey = useSet(setDirectedConnectCustomDialogKey$);
  const resetConnectInput = useSet(resetCustomConnectorConnectInput$);
  const completeAction = useSet(completeDirectedConnectorAction$);
  const reloadAccounts = useSet(reloadDirectedConnectAccounts$);
  const actionCallback = useGet(routeChatActionCallback$);
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
  const handleConnectSuccess: ConnectorConnectSuccess = (
    _connectionId,
    attemptSignal,
  ) => {
    reloadAccounts(attemptSignal);
    return completeAction(agentId, actionCallback, attemptSignal);
  };
  const setDialogOpen = (open: boolean) => {
    setDialogKey(open ? { connectorSlug, agentId } : null, signal);
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
        isLoading={
          connectorsLoadable.state === "loading" ||
          connectedLoadable.state === "loading"
        }
        isConnected={
          connectedLoadable.state === "hasData" && connectedLoadable.data
        }
        isConnecting={false}
        canConnect={
          connection !== null && connectedLoadable.state === "hasData"
        }
        onConnect={() => {
          if (!connection) {
            return;
          }
          resetConnectInput();
          setDialogOpen(true);
        }}
      />
      <DirectedActionError loadable={connectedLoadable} />
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
