import {
  useGet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { ReactNode } from "react";
import { EllipsisVertical } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  surfaceVariants,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@okouai/ui";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  closeCustomConnectorDialog$,
  connectCustomConnectorAuthorizationWithDialog$,
  customConnectorAuthorizedAgentsById$,
  customConnectorDialog$,
  customConnectors$,
  openCustomConnectorAccessDialog$,
  openCustomConnectorDeleteDialog$,
  openCustomConnectorEditDialog$,
} from "../../../../signals/okou-page/settings/custom-connectors.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import { CustomConnectorCreateDialog } from "./custom-connector-create-dialog.tsx";
import { CustomConnectorConnectDialog } from "./custom-connector-connect-dialog.tsx";
import { CustomConnectorDeleteConfirm } from "./custom-connector-delete-confirm.tsx";
import { CustomConnectorAccessManagementDialog } from "./connector-access-management-dialog.tsx";
import {
  ConnectorAgentAccessButton,
  connectorAgentAccessStatus,
} from "./connector-agent-access-button.tsx";
import { DropdownMenuModalItem } from "../../../components/dropdown-menu-modal-item.tsx";
import { noConnectorImg } from "../../platform-assets.ts";
import { customConnectorTarget } from "./custom-connector-display.ts";
import { connectorAccountSummaryByTarget$ } from "../../../../signals/okou-page/connector-accounts.ts";
import { ConnectorAccountManagerDialog } from "./connector-account-manager-dialog.tsx";
import {
  ConnectorAccountSummaryText,
  connectorAccountSummaryStatus,
  type ConnectorAccountSummaryStatus,
} from "./connector-card.tsx";
import {
  closeCustomAccountConnectDialog$,
  closeCustomAccountManager$,
  customAccountConnectDialog$,
  customAccountManager$,
  finishConnectorAccountConnection$,
  openCustomAccountConnectDialog$,
  openCustomAccountManager$,
} from "../../../../signals/okou-page/settings/connector-account-dialogs.ts";
import { connectorConnectionPending$ } from "../../../../signals/connector-connection-progress.ts";
import {
  connectorDirectoryEnabled$,
  focusCreatedDirectoryConnector$,
} from "../../../../signals/okou-page/settings/connector-directory-route.ts";

function connectsDirectlyWithAuthorization(
  connector: CustomConnectorResponse,
): boolean {
  return connector.authMode === "oauth" || connector.authMode === "automatic";
}

interface CustomConnectorRowProps {
  readonly connector: CustomConnectorResponse;
  readonly isAdmin: boolean;
  readonly onConnect: () => void;
  readonly onEdit: () => void;
  readonly onManageAccess: () => void;
  readonly onDelete: () => void;
  readonly accountSummary?: ConnectorAccountSummary;
  readonly accountSummaryStatus: ConnectorAccountSummaryStatus;
  readonly onManageAccounts: () => void;
}

function CustomConnectorAgentAccess({
  connector,
  allowAccessIncrease,
  onManageAccess,
}: {
  readonly connector: CustomConnectorResponse;
  readonly allowAccessIncrease: boolean;
  readonly onManageAccess: () => void;
}) {
  const authorizedAgentsByIdLoadable = useLastLoadable(
    customConnectorAuthorizedAgentsById$,
  );
  const authorizedAgents =
    authorizedAgentsByIdLoadable.state === "hasData"
      ? (authorizedAgentsByIdLoadable.data.get(connector.id) ?? [])
      : [];

  return (
    <ConnectorAgentAccessButton
      agents={authorizedAgents}
      status={connectorAgentAccessStatus(authorizedAgentsByIdLoadable.state)}
      allowAccessIncrease={allowAccessIncrease}
      connectorLabel={connector.displayName}
      onClick={onManageAccess}
    />
  );
}

interface CustomConnectorCardContentProps {
  readonly connector: CustomConnectorResponse;
  readonly hasActions: boolean;
  readonly allowAccessIncrease: boolean;
  readonly onManageAccess: () => void;
  readonly accountSummary?: ConnectorAccountSummary;
  readonly accountSummaryStatus: ConnectorAccountSummaryStatus;
}

function CustomConnectorHeaderContent({
  connector,
}: {
  readonly connector: CustomConnectorResponse;
}) {
  const { t } = useTranslation();
  const connectorType =
    connector.kind === "mcp"
      ? t(($) => {
          return $.connectors.custom.mcpType;
        })
      : t(($) => {
          return $.connectors.custom.create.httpType;
        });
  const connectorTarget = customConnectorTarget(connector);
  return (
    <>
      <CustomConnectorIcon
        id={connector.id}
        displayName={connector.displayName}
        size={20}
      />
      <span className="min-w-0 flex-1">
        <span
          data-testid="connector-card-label"
          className="block truncate text-sm font-medium text-foreground"
        >
          {connector.displayName}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">{connectorType}</span>
          <span aria-hidden="true">·</span>
          <span
            className="min-w-0 truncate font-mono text-muted-foreground/60"
            title={connectorTarget}
          >
            {connectorTarget}
          </span>
        </span>
      </span>
    </>
  );
}

function CustomConnectorCardHeader({
  connector,
}: Pick<CustomConnectorCardContentProps, "connector">) {
  return (
    <div className="flex h-14 items-center gap-2.5 px-5">
      <CustomConnectorHeaderContent connector={connector} />
    </div>
  );
}

function CustomConnectorCardFooter({
  connector,
  hasActions,
  allowAccessIncrease,
  onManageAccess,
  accountSummary,
  accountSummaryStatus,
}: CustomConnectorCardContentProps) {
  return (
    <div
      className={`flex h-11 items-center justify-between gap-2 border-t border-border/50 pl-5 ${
        hasActions ? "pr-12" : "pr-2"
      }`}
    >
      <ConnectorAccountSummaryText
        summary={accountSummary}
        status={accountSummaryStatus}
        className="min-w-0 flex-1 text-xs text-muted-foreground"
      />
      <div className="relative z-20 min-w-0 max-w-full">
        <CustomConnectorAgentAccess
          connector={connector}
          allowAccessIncrease={allowAccessIncrease}
          onManageAccess={onManageAccess}
        />
      </div>
    </div>
  );
}

function CustomConnectorCardContent(props: CustomConnectorCardContentProps) {
  return (
    <>
      <CustomConnectorCardHeader connector={props.connector} />
      <CustomConnectorCardFooter {...props} />
    </>
  );
}

function CustomConnectorActivationCard({
  connectorLabel,
  canActivate,
  connecting,
  managesAccounts,
  onActivate,
  children,
}: {
  readonly connectorLabel: string;
  readonly canActivate: boolean;
  readonly connecting: boolean;
  readonly managesAccounts: boolean;
  readonly onActivate: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-slot="connector-card"
      className={surfaceVariants({
        interactive: canActivate && !connecting,
        className: "relative flex flex-col",
      })}
    >
      {canActivate ? (
        <button
          type="button"
          disabled={connecting}
          aria-label={t(
            ($) => {
              return managesAccounts
                ? $.connectors.accounts.managerTitle
                : $.connectors.card.connectAria;
            },
            { connector: connectorLabel },
          )}
          className="absolute inset-0 z-10 cursor-pointer rounded-[inherit] border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default"
          onClick={onActivate}
        />
      ) : null}
      {children}
    </div>
  );
}

function CustomConnectorActions({
  hasActions,
  adminCanEdit,
  adminCanDelete,
  onEdit,
  onDelete,
}: {
  readonly hasActions: boolean;
  readonly adminCanEdit: boolean;
  readonly adminCanDelete: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation();
  if (!hasActions) {
    return null;
  }
  return (
    <div className="absolute bottom-2 right-2 z-20">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            showTooltip
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
            aria-label={t(($) => {
              return $.connectors.custom.moreOptions;
            })}
          >
            <EllipsisVertical size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {adminCanEdit ? (
            <DropdownMenuModalItem onModalSelect={onEdit}>
              {t(($) => {
                return $.connectors.actions.edit;
              })}
            </DropdownMenuModalItem>
          ) : null}
          {adminCanDelete ? (
            <DropdownMenuModalItem
              onModalSelect={onDelete}
              className="text-destructive focus:text-destructive"
            >
              {t(($) => {
                return $.connectors.actions.delete;
              })}
            </DropdownMenuModalItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function CustomConnectorRow({
  connector,
  isAdmin,
  onConnect,
  onEdit,
  onManageAccess,
  onDelete,
  accountSummary,
  accountSummaryStatus,
  onManageAccounts,
}: CustomConnectorRowProps) {
  const focusCreated = useSet(focusCreatedDirectoryConnector$);
  const directoryEnabled = useGet(connectorDirectoryEnabled$);
  const connecting = useGet(connectorConnectionPending$);
  const adminCanDelete = isAdmin;
  const accountCount = accountSummary?.accountCount ?? 0;
  const canActivate = accountSummaryStatus === "ready";
  const activate = accountCount > 0 ? onManageAccounts : onConnect;
  const managesAccounts = accountCount > 0;
  const hasActions = adminCanDelete;
  const cardContent = (
    <CustomConnectorCardContent
      connector={connector}
      hasActions={hasActions}
      allowAccessIncrease={accountCount > 0}
      onManageAccess={onManageAccess}
      accountSummary={accountSummary}
      accountSummaryStatus={accountSummaryStatus}
    />
  );

  return (
    <div
      className="relative"
      data-custom-connector-id={directoryEnabled ? connector.id : undefined}
      ref={directoryEnabled ? focusCreated : undefined}
      tabIndex={directoryEnabled ? -1 : undefined}
    >
      <CustomConnectorActivationCard
        connectorLabel={connector.displayName}
        canActivate={canActivate}
        connecting={connecting}
        managesAccounts={managesAccounts}
        onActivate={activate}
      >
        {cardContent}
      </CustomConnectorActivationCard>
      <CustomConnectorActions
        hasActions={hasActions}
        adminCanEdit={isAdmin}
        adminCanDelete={adminCanDelete}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}

function CustomConnectorDialogs({
  onCreated,
}: {
  readonly onCreated?: (connector: CustomConnectorResponse) => void;
}) {
  const dialog = useGet(customConnectorDialog$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const accountSummariesLoadable = useLoadable(
    connectorAccountSummaryByTarget$,
  );
  const accessAccountSummary =
    dialog.kind === "access" && accountSummariesLoadable.state === "hasData"
      ? accountSummariesLoadable.data.get(`custom:${dialog.connector.id}`)
      : undefined;
  const allowAccessIncrease =
    dialog.kind === "access" &&
    accountSummariesLoadable.state === "hasData" &&
    (accessAccountSummary?.accountCount ?? 0) > 0;
  return (
    <>
      {dialog.kind === "create" && (
        <CustomConnectorCreateDialog onCreated={onCreated} />
      )}
      {dialog.kind === "edit" && (
        <CustomConnectorCreateDialog connector={dialog.connector} />
      )}
      {dialog.kind === "access" && (
        <CustomConnectorAccessManagementDialog
          connector={dialog.connector}
          allowAccessIncrease={allowAccessIncrease}
          onClose={closeDialog}
        />
      )}
      {dialog.kind === "delete" && (
        <CustomConnectorDeleteConfirm
          id={dialog.connector.id}
          displayName={dialog.connector.displayName}
        />
      )}
    </>
  );
}

function CustomConnectorEmptyState({ isAdmin }: { readonly isAdmin: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={surfaceVariants({
        className: "py-12 flex flex-col items-center gap-3",
      })}
    >
      <img
        src={noConnectorImg}
        alt={t(($) => {
          return $.connectors.catalog.noConnectorsAlt;
        })}
        className="h-20 w-20 object-contain opacity-80"
      />
      <p className="text-sm text-muted-foreground text-center">
        {isAdmin
          ? t(($) => {
              return $.connectors.custom.emptyAdmin;
            })
          : t(($) => {
              return $.connectors.custom.emptyMember;
            })}
      </p>
    </div>
  );
}

export function CustomConnectorGrid({
  connectors,
  isAdmin,
  className = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3",
}: {
  readonly connectors: readonly CustomConnectorResponse[];
  readonly isAdmin: boolean;
  /**
   * The grid this owns, or `contents` when the caller has a grid of its own and
   * wants these cards to sit in it beside connectors of another kind.
   */
  readonly className?: string;
}) {
  const accountSummariesLoadable = useLoadable(
    connectorAccountSummaryByTarget$,
  );
  const accountSummaryStatus = connectorAccountSummaryStatus(
    accountSummariesLoadable.state,
  );
  const openEdit = useSet(openCustomConnectorEditDialog$);
  const openAccess = useSet(openCustomConnectorAccessDialog$);
  const openDelete = useSet(openCustomConnectorDeleteDialog$);
  const connectAccountAuthorization = useSet(
    connectCustomConnectorAuthorizationWithDialog$,
  );
  const signal = useGet(pageSignal$);
  const openAccountManager = useSet(openCustomAccountManager$);
  const openAccountConnect = useSet(openCustomAccountConnectDialog$);
  const finishAccountConnection = useSet(finishConnectorAccountConnection$);
  const finishExplicitAccountAdd = async (
    connector: CustomConnectorResponse,
    connectionId: string | null,
    attemptSignal: AbortSignal,
  ): Promise<void> => {
    await finishAccountConnection(
      {
        target: { kind: "custom", customConnectorId: connector.id },
        connectionId,
        connectorLabel: connector.displayName,
        mode: { kind: "add" },
      },
      attemptSignal,
    );
  };
  const handleConnect = (connector: CustomConnectorResponse) => {
    if (connectsDirectlyWithAuthorization(connector)) {
      detach(
        connectAccountAuthorization(
          {
            id: connector.id,
            account: { intent: "add" },
            onSuccess: (connectionId, attemptSignal) => {
              return finishExplicitAccountAdd(
                connector,
                connectionId,
                attemptSignal,
              );
            },
          },
          signal,
        ),
        Reason.DomCallback,
      );
      return;
    }
    openAccountConnect(connector, { kind: "add" });
  };
  return (
    <div className={className}>
      {connectors.map((connector) => {
        const accountSummary =
          accountSummariesLoadable.state === "hasData"
            ? accountSummariesLoadable.data.get(`custom:${connector.id}`)
            : undefined;
        return (
          <CustomConnectorRow
            key={connector.id}
            connector={connector}
            isAdmin={isAdmin}
            onConnect={() => {
              return handleConnect(connector);
            }}
            onEdit={() => {
              return openEdit(connector);
            }}
            onManageAccess={() => {
              return openAccess(connector);
            }}
            onDelete={() => {
              return openDelete(connector);
            }}
            accountSummary={accountSummary}
            accountSummaryStatus={accountSummaryStatus}
            onManageAccounts={() => {
              return openAccountManager(connector, signal);
            }}
          />
        );
      })}
    </div>
  );
}

function CustomAccountDialogs() {
  const managedAccounts = useGet(customAccountManager$);
  const accountConnect = useGet(customAccountConnectDialog$);
  const closeAccountManager = useSet(closeCustomAccountManager$);
  const closeAccountConnect = useSet(closeCustomAccountConnectDialog$);
  const openAccountConnect = useSet(openCustomAccountConnectDialog$);
  const finishAccountConnection = useSet(finishConnectorAccountConnection$);
  const connectAccountAuthorization = useSet(
    connectCustomConnectorAuthorizationWithDialog$,
  );
  const signal = useGet(pageSignal$);
  return (
    <>
      {accountConnect ? (
        <CustomConnectorConnectDialog
          connector={accountConnect.connector}
          accountMode={accountConnect.mode}
          accountOptions={{
            account:
              accountConnect.mode.kind === "add"
                ? { intent: "add" }
                : {
                    intent: "reconnect",
                    connectionId: accountConnect.mode.connectionId,
                  },
          }}
          onClose={closeAccountConnect}
          onSuccess={async (connectionId, attemptSignal) => {
            await finishAccountConnection(
              {
                target: {
                  kind: "custom",
                  customConnectorId: accountConnect.connector.id,
                },
                connectionId,
                connectorLabel: accountConnect.connector.displayName,
                mode: accountConnect.mode,
              },
              attemptSignal,
            );
          }}
        />
      ) : null}
      {managedAccounts ? (
        <ConnectorAccountManagerDialog
          target={{ kind: "custom", customConnectorId: managedAccounts.id }}
          connectorLabel={managedAccounts.displayName}
          icon={
            <CustomConnectorIcon
              id={managedAccounts.id}
              displayName={managedAccounts.displayName}
              size={20}
            />
          }
          onClose={closeAccountManager}
          onAdd={() => {
            closeAccountManager();
            if (connectsDirectlyWithAuthorization(managedAccounts)) {
              detach(
                connectAccountAuthorization(
                  {
                    id: managedAccounts.id,
                    account: { intent: "add" },
                    onSuccess: (connectionId, attemptSignal) => {
                      return finishAccountConnection(
                        {
                          target: {
                            kind: "custom",
                            customConnectorId: managedAccounts.id,
                          },
                          connectionId,
                          connectorLabel: managedAccounts.displayName,
                          mode: { kind: "add" },
                        },
                        attemptSignal,
                      );
                    },
                  },
                  signal,
                ),
                Reason.DomCallback,
              );
              return;
            }
            openAccountConnect(managedAccounts, { kind: "add" });
          }}
          onReconnect={(account) => {
            openAccountConnect(managedAccounts, {
              kind: "reconnect",
              connectionId: account.id,
            });
          }}
        />
      ) : null}
    </>
  );
}

export function CustomConnectorsPanel() {
  const connectors = useLastResolved(customConnectors$);
  const userManagedConnectors = connectors?.filter((connector) => {
    return !isIntegrationManagedCustomConnector(connector);
  });
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;

  return (
    <section className="flex flex-col gap-3">
      {userManagedConnectors?.length === 0 ? (
        <CustomConnectorEmptyState isAdmin={isAdmin} />
      ) : null}
      {userManagedConnectors && userManagedConnectors.length > 0 ? (
        <CustomConnectorGrid
          connectors={userManagedConnectors}
          isAdmin={isAdmin}
        />
      ) : null}
      <CustomConnectorDialogs />
      <CustomAccountDialogs />
    </section>
  );
}

export function CustomConnectorDirectoryDialogs({
  onCreated,
}: {
  readonly onCreated: (connector: CustomConnectorResponse) => void;
}) {
  return (
    <>
      <CustomConnectorDialogs onCreated={onCreated} />
      <CustomAccountDialogs />
    </>
  );
}
