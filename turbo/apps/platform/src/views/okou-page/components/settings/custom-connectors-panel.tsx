import { useLoadableSet } from "ccstate-react/experimental";
import {
  useLastResolved,
  useGet,
  useLastLoadable,
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@okouai/ui";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  customConnectorDialog$,
  openCustomConnectorDeleteDialog$,
  openCustomConnectorEditDialog$,
} from "../../../../signals/okou-page/settings/custom-connectors.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import { CustomConnectorCreateDialog } from "./custom-connector-create-dialog.tsx";
import { CustomConnectorConnectDialog } from "./custom-connector-connect-dialog.tsx";
import { CustomConnectorDeleteConfirm } from "./custom-connector-delete-confirm.tsx";

import { customConnectorTarget } from "./custom-connector-display.ts";
import { connectedConnectorTargetKeys$ } from "../../../../signals/okou-page/connector-accounts.ts";
import { ConnectorAccountManagerDialog } from "./connector-account-manager-dialog.tsx";
import {
  ConnectorMembershipText,
  connectorInventoryStatus,
  type ConnectorInventoryStatus,
} from "./connector-card.tsx";
import {
  closeCustomAccountManager$,
  customAccountConnectDialog$,
  customAccountManager$,
  openCustomAccountConnectDialog$,
  openCustomAccountManager$,
} from "../../../../signals/okou-page/settings/connector-account-dialogs.ts";
import { focusCreatedDirectoryConnector$ } from "../../../../signals/okou-page/settings/connector-directory-route.ts";
import { connectCustomConnectorAuthorizationAndContinue$ } from "../../../../signals/okou-page/settings/connector-connect-continuation.ts";

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
  readonly onDelete: () => void;
  readonly hasAccounts: boolean;
  readonly inventoryStatus: ConnectorInventoryStatus;
  readonly onManageAccounts: () => void;
  readonly connecting: boolean;
}

interface CustomConnectorCardContentProps {
  readonly connector: CustomConnectorResponse;
  readonly hasActions: boolean;
  readonly hasAccounts: boolean;
  readonly inventoryStatus: ConnectorInventoryStatus;
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
          <span className="min-w-0 truncate font-mono text-muted-foreground/60">
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
  hasActions,
  hasAccounts,
  inventoryStatus,
}: Omit<CustomConnectorCardContentProps, "connector">) {
  return (
    <div
      className={`flex h-11 items-center justify-between gap-2 border-t border-border/50 pl-5 ${
        hasActions ? "pr-12" : "pr-2"
      }`}
    >
      <ConnectorMembershipText
        connected={hasAccounts}
        status={inventoryStatus}
      />
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
          className="absolute inset-0 z-10 rounded-[inherit] border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
        <DropdownMenuTrigger
          render={
            <Button
              showTooltip
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
              aria-label={t(($) => {
                return $.connectors.custom.moreOptions;
              })}
            />
          }
        >
          <EllipsisVertical size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {adminCanEdit ? (
            <DropdownMenuItem onClick={onEdit}>
              {t(($) => {
                return $.connectors.actions.edit;
              })}
            </DropdownMenuItem>
          ) : null}
          {adminCanDelete ? (
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              {t(($) => {
                return $.connectors.actions.delete;
              })}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function CustomConnectorRow({
  connector,
  connecting,
  isAdmin,
  onConnect,
  onEdit,
  onDelete,
  hasAccounts,
  inventoryStatus,
  onManageAccounts,
}: CustomConnectorRowProps) {
  const focusCreated = useSet(focusCreatedDirectoryConnector$);
  const adminCanDelete = isAdmin;
  const canActivate = inventoryStatus === "ready";
  const activate = hasAccounts ? onManageAccounts : onConnect;
  const managesAccounts = hasAccounts;
  const hasActions = adminCanDelete;
  const cardContent = (
    <CustomConnectorCardContent
      connector={connector}
      hasActions={hasActions}
      hasAccounts={hasAccounts}
      inventoryStatus={inventoryStatus}
    />
  );

  // Keep the More trigger above the whole-card action within this card.
  return (
    <div
      className="relative isolate"
      data-custom-connector-id={connector.id}
      ref={focusCreated}
      tabIndex={-1}
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

function CustomConnectorDialogs() {
  const dialog = useGet(customConnectorDialog$);
  return (
    <>
      {dialog.kind === "create" && <CustomConnectorCreateDialog />}
      {dialog.kind === "edit" && (
        <CustomConnectorCreateDialog connector={dialog.connector} />
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
  const connectedTargetsLoadable = useLastLoadable(
    connectedConnectorTargetKeys$,
  );
  const inventoryStatus = connectorInventoryStatus(
    connectedTargetsLoadable.state,
  );
  const openEdit = useSet(openCustomConnectorEditDialog$);
  const openDelete = useSet(openCustomConnectorDeleteDialog$);
  const [connection, connectAccountAuthorization] = useLoadableSet(
    connectCustomConnectorAuthorizationAndContinue$,
  );
  const signal = useGet(pageSignal$);
  const openAccountManager = useSet(openCustomAccountManager$);
  const openAccountConnect = useSet(openCustomAccountConnectDialog$);
  const handleConnect = (connector: CustomConnectorResponse) => {
    if (connectsDirectlyWithAuthorization(connector)) {
      detach(
        connectAccountAuthorization(
          {
            connector,
            account: { intent: "add" },
            origin: { kind: "account", mode: { kind: "add" } },
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
        const hasAccount =
          connectedTargetsLoadable.state === "hasData"
            ? connectedTargetsLoadable.data.has(`custom:${connector.id}`)
            : undefined;
        return (
          <CustomConnectorRow
            key={connector.id}
            connector={connector}
            isAdmin={isAdmin}
            connecting={connection.state === "loading"}
            onConnect={() => {
              return handleConnect(connector);
            }}
            onEdit={() => {
              return openEdit(connector);
            }}
            onDelete={() => {
              return openDelete(connector);
            }}
            hasAccounts={hasAccount === true}
            inventoryStatus={inventoryStatus}
            onManageAccounts={() => {
              return openAccountManager(connector, signal);
            }}
          />
        );
      })}
    </div>
  );
}

export function CustomAccountDialogs({
  finalFocus,
}: {
  readonly finalFocus?: () => HTMLElement | boolean;
}) {
  const managedAccounts = useGet(customAccountManager$);
  const accountConnect = useGet(customAccountConnectDialog$);
  const closeAccountManager = useSet(closeCustomAccountManager$);
  const openAccountConnect = useSet(openCustomAccountConnectDialog$);
  const connectAccountAuthorization = useSet(
    connectCustomConnectorAuthorizationAndContinue$,
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
          origin={{ kind: "account", mode: accountConnect.mode }}
        />
      ) : null}
      {managedAccounts ? (
        <ConnectorAccountManagerDialog
          finalFocus={finalFocus}
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
                    connector: managedAccounts,
                    account: { intent: "add" },
                    origin: { kind: "account", mode: { kind: "add" } },
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
              account,
            });
          }}
        />
      ) : null}
    </>
  );
}

export function CustomConnectorDirectoryDialogs() {
  return (
    <>
      <CustomConnectorDialogs />
      <CustomAccountDialogs />
    </>
  );
}
