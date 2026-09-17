import type { ReactNode } from "react";

import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal, Loader2, Search, X } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type {
  CustomConnectorResponse,
  CustomConnectorPermissionBundleResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { PlatformConnectorPermissionMetadata } from "../../../../signals/connector-domain.ts";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { applyUserPermissionGrants$ } from "../../../../signals/permission-allow/permission-allow-signals.ts";
import { activeUserPermissionGrantSnapshot } from "../../../../signals/user-permission-grants.ts";
import {
  managedConnectorAgentAccessRows$,
  managedConnectorFirewallPermissionMetadata$,
  connectorAccessManagementPermissionAgentId$,
  connectorAccessManagementSearch$,
  setConnectorAgentAuthorization$,
  setConnectorAccessManagementPermissionAgentId$,
  setConnectorAccessManagementSearch$,
  type ConnectorAgentAccessRow,
} from "../../../../signals/okou-page/settings/connector-access-management.ts";
import {
  customConnectorAgentAuthorizations$,
  setCustomConnectorAgentAuthorization$,
  type CustomConnectorAgentAuthorization,
} from "../../../../signals/okou-page/settings/custom-connectors.ts";
import {
  closeCustomConnectorPermissions$,
  customConnectorPermissionBundle$,
  customConnectorPermissionDraft$,
  openCustomConnectorPermissions$,
  type CustomConnectorPermissionDraft,
} from "../../../../signals/okou-page/settings/custom-connector-permissions.ts";
import {
  savePermissionDraftPolicies,
  type ApplyUserPermissionGrants,
} from "../../../../signals/okou-page/settings/permission-grant-save.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { LoadingSwitch } from "../../../components/loading-switch.tsx";
import { toast } from "@okouai/ui/components/ui/sonner";
import { AvatarFromUrl } from "../../sidebar-shared.tsx";
import { ConnectorIcon } from "./connector-icons.tsx";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import { CustomConnectorPermissionsDrawer } from "./custom-connector-permissions-drawer.tsx";
import { PermissionsDialog } from "./permissions-dialog.tsx";
import { i18n } from "../../../../i18n/index.ts";
import { IconTooltipButton } from "../../../components/icon-tooltip.tsx";
import { MercuryDisclosure } from "./mercury-disclosure.tsx";

interface ConnectorAccessManagementDialogProps {
  readonly connectorSlug: ConnectorSlug;
  readonly connectorLabel: string;
  readonly allowAccessIncrease: boolean;
  readonly onClose: () => void;
}

function agentName(agent: AgentResponse): string {
  return (
    agent.displayName ??
    i18n.t(($) => {
      return $.connectors.access.unnamedAgent;
    })
  );
}

function filterRows(
  rows: readonly ConnectorAgentAccessRow[],
  search: string,
): readonly ConnectorAgentAccessRow[] {
  const normalizedSearch = search.trim().toLowerCase();
  if (!normalizedSearch) {
    return rows;
  }
  return rows.filter((row) => {
    return agentName(row.agent).toLowerCase().includes(normalizedSearch);
  });
}

function ConnectorAccessSearch({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <Search
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
      />
      <Input
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        aria-label={t(($) => {
          return $.connectors.access.search;
        })}
        placeholder={t(($) => {
          return $.connectors.access.search;
        })}
        className="pl-9 pr-9"
      />
      {value && (
        <IconTooltipButton
          type="button"
          onClick={() => {
            onChange("");
          }}
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
          aria-label={t(($) => {
            return $.connectors.access.clearSearch;
          })}
        >
          <X size={13} />
        </IconTooltipButton>
      )}
    </div>
  );
}

function AgentAccessRow({
  row,
  connectorLabel,
  hasPermissions,
  allowAccessIncrease,
  saving,
  onToggle,
  onManage,
}: {
  readonly row: ConnectorAgentAccessRow;
  readonly connectorLabel: string;
  readonly hasPermissions: boolean;
  readonly allowAccessIncrease: boolean;
  readonly saving: boolean;
  readonly onToggle: (
    row: ConnectorAgentAccessRow,
    authorized: boolean,
  ) => void;
  readonly onManage: (row: ConnectorAgentAccessRow) => void;
}) {
  const { t } = useTranslation();
  const name = agentName(row.agent);
  const canManage = row.authorized && hasPermissions;

  return (
    <div className="flex items-center gap-2 px-1 py-4">
      <AvatarFromUrl
        avatarUrl={row.agent.avatarUrl}
        alt={name}
        className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
      </div>
      {canManage && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={() => {
                  onManage(row);
                }}
                aria-label={t(
                  ($) => {
                    return $.connectors.access.managePermissionsFor;
                  },
                  { connector: connectorLabel, agent: name },
                )}
                variant="quiet"
                size="icon-sm"
                className="shrink-0"
              >
                <SlidersHorizontal size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t(($) => {
                return $.connectors.access.managePermissions;
              })}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <LoadingSwitch
        checked={row.authorized}
        loading={saving}
        disabled={!row.authorized && !allowAccessIncrease}
        onCheckedChange={(checked) => {
          onToggle(row, checked);
        }}
        ariaLabel={t(
          ($) => {
            return $.connectors.access.accessFor;
          },
          {
            action: row.authorized
              ? t(($) => {
                  return $.connectors.actions.revoke;
                })
              : t(($) => {
                  return $.connectors.actions.authorize;
                }),
            connector: connectorLabel,
            agent: name,
          },
        )}
      />
    </div>
  );
}

type AccessRowProps = Omit<
  Parameters<typeof AgentAccessRow>[0],
  "saving" | "onToggle"
>;

function BuiltInAgentAccessRow({
  connectorSlug,
  ...props
}: AccessRowProps & { readonly connectorSlug: ConnectorSlug }) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [result, authorize] = useLoadableSet(setConnectorAgentAuthorization$);
  const saving = result.state === "loading";
  return (
    <AgentAccessRow
      {...props}
      saving={saving}
      onToggle={(row, authorized) => {
        if (saving) {
          return;
        }
        detach(
          (async () => {
            await authorize(
              { agentId: row.agent.agentId, connectorSlug, authorized },
              signal,
            );
            toast.success(
              t(
                ($) => {
                  return $.connectors.access.accessUpdated;
                },
                {
                  connector: props.connectorLabel,
                },
              ),
            );
          })(),
          Reason.DomCallback,
        );
      }}
    />
  );
}

function CustomAgentAccessRow({
  connector,
  ...props
}: AccessRowProps & { readonly connector: CustomConnectorResponse }) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [result, authorize] = useLoadableSet(
    setCustomConnectorAgentAuthorization$,
  );
  const saving = result.state === "loading";
  return (
    <AgentAccessRow
      {...props}
      saving={saving}
      onToggle={(row, authorized) => {
        if (saving) {
          return;
        }
        if (authorized && connector.permissionBundleRef) {
          props.onManage(row);
          return;
        }
        detach(
          (async () => {
            await authorize(
              {
                agentId: row.agent.agentId,
                connectorId: connector.id,
                permissionBundleRef: connector.permissionBundleRef ?? null,
                authorized,
              },
              signal,
            );
            toast.success(
              t(
                ($) => {
                  return $.connectors.access.accessUpdated;
                },
                {
                  connector: connector.displayName,
                },
              ),
            );
          })(),
          Reason.DomCallback,
        );
      }}
    />
  );
}

function AgentAccessList({
  rows,
  search,
  renderRow,
}: {
  readonly rows: readonly ConnectorAgentAccessRow[];
  readonly search: string;
  readonly renderRow: (row: ConnectorAgentAccessRow) => ReactNode;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {search.trim()
          ? t(
              ($) => {
                return $.connectors.access.noMatchingAgents;
              },
              {
                search: search.trim(),
              },
            )
          : t(($) => {
              return $.connectors.access.noAgents;
            })}
      </p>
    );
  }
  return (
    <div className="-mr-6 h-full min-h-0 overflow-y-auto pr-6">
      {rows.map(renderRow)}
    </div>
  );
}

function LoadingAgents() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[240px] flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 size={16} className="animate-spin" />
      {t(($) => {
        return $.connectors.access.loading;
      })}
    </div>
  );
}

function ConnectorAccessDialog({
  onClose,
  connectorLabel,
  headerIcon,
  rows,
  rowsLoaded,
  search,
  onSearchChange,
  renderRow,
  footer,
}: {
  readonly onClose: () => void;
  readonly connectorLabel: string;
  readonly headerIcon: ReactNode;
  readonly rows: readonly ConnectorAgentAccessRow[];
  readonly rowsLoaded: boolean;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly renderRow: (row: ConnectorAgentAccessRow) => ReactNode;
  readonly footer?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && onClose();
      }}
    >
      <DialogContent
        maxWidth={720}
        height={720}
        contentClassName="flex flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0 gap-2">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              {headerIcon}
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base">
                {t(
                  ($) => {
                    return $.connectors.access.title;
                  },
                  { connector: connectorLabel },
                )}
              </DialogTitle>
              <DialogDescription>
                {t(($) => {
                  return $.connectors.access.description;
                })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="shrink-0">
          <ConnectorAccessSearch value={search} onChange={onSearchChange} />
        </div>

        <div
          className={cn(
            "min-h-0 flex-1",
            !rowsLoaded && "flex",
            rowsLoaded && "flex flex-col",
          )}
        >
          {rowsLoaded ? (
            <AgentAccessList
              rows={rows}
              search={search}
              renderRow={renderRow}
            />
          ) : (
            <LoadingAgents />
          )}
        </div>
        {footer}
      </DialogContent>
    </Dialog>
  );
}

function AgentPermissionDialog({
  row,
  metadata,
  connectorSlug,
  connectorLabel,
  applyGrantPolicies,
  onClose,
}: {
  readonly row: ConnectorAgentAccessRow | undefined;
  readonly metadata: PlatformConnectorPermissionMetadata | null;
  readonly connectorSlug: ConnectorSlug;
  readonly connectorLabel: string;
  readonly applyGrantPolicies: ApplyUserPermissionGrants;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const grants = row?.grants ?? [];
  if (!row || !metadata) {
    return null;
  }
  const activeSnapshot = activeUserPermissionGrantSnapshot(grants);
  const initialPolicies = activeSnapshot.policies ?? {};

  return (
    <PermissionsDialog
      agentId={row.agent.agentId}
      connectorSlug={connectorSlug}
      connectorLabel={connectorLabel}
      metadata$={managedConnectorFirewallPermissionMetadata$}
      displayName={agentName(row.agent)}
      initialPolicies={initialPolicies}
      initialGrants={activeSnapshot.grants}
      readOnly={false}
      onApply={async (intent, { metadata: appliedMetadata }) => {
        await savePermissionDraftPolicies(
          {
            scope: { agentId: row.agent.agentId },
            connectorSlug,
            metadata: appliedMetadata,
            initialPolicies,
            initialGrants: activeSnapshot.grants,
            intent,
            applyGrantPolicies,
          },
          pageSignal,
        );
        toast.success(
          t(($) => {
            return $.connectors.access.permissionsUpdated;
          }),
        );
      }}
      onClose={onClose}
    />
  );
}

export function ConnectorAccessManagementDialog({
  connectorSlug,
  connectorLabel,
  allowAccessIncrease,
  onClose,
}: ConnectorAccessManagementDialogProps) {
  const rowsLoadable = useLastLoadable(managedConnectorAgentAccessRows$);
  const metadataLoadable = useLastLoadable(
    managedConnectorFirewallPermissionMetadata$,
  );
  const search = useGet(connectorAccessManagementSearch$);
  const permissionAgentId = useGet(connectorAccessManagementPermissionAgentId$);
  const setSearch = useSet(setConnectorAccessManagementSearch$);
  const setPermissionAgentId = useSet(
    setConnectorAccessManagementPermissionAgentId$,
  );
  const [, applyGrantPolicies] = useLoadableSet(applyUserPermissionGrants$);
  const rows = rowsLoadable.state === "hasData" ? rowsLoadable.data : [];
  const metadata =
    metadataLoadable.state === "hasData" ? metadataLoadable.data : null;
  const selectedPermissionRow = permissionAgentId
    ? rows.find((row) => {
        return row.agent.agentId === permissionAgentId && row.authorized;
      })
    : undefined;

  return (
    <>
      <ConnectorAccessDialog
        onClose={onClose}
        connectorLabel={connectorLabel}
        headerIcon={<ConnectorIcon icon={metadata?.icon} size={22} />}
        rows={filterRows(rows, search)}
        rowsLoaded={rowsLoadable.state === "hasData"}
        search={search}
        onSearchChange={setSearch}
        renderRow={(row) => {
          return (
            <BuiltInAgentAccessRow
              key={row.agent.agentId}
              row={row}
              connectorSlug={connectorSlug}
              connectorLabel={connectorLabel}
              hasPermissions={(metadata?.permissionCount ?? 0) > 0}
              allowAccessIncrease={allowAccessIncrease}
              onManage={(selectedRow) => {
                setPermissionAgentId(selectedRow.agent.agentId);
              }}
            />
          );
        }}
        footer={
          connectorSlug === "mercury" ? (
            <MercuryDisclosure className="shrink-0 border-t border-border/50 pt-3" />
          ) : undefined
        }
      />
      <AgentPermissionDialog
        row={selectedPermissionRow}
        metadata={metadata}
        connectorSlug={connectorSlug}
        connectorLabel={connectorLabel}
        applyGrantPolicies={applyGrantPolicies}
        onClose={() => {
          setPermissionAgentId(null);
        }}
      />
    </>
  );
}

function customConnectorAccessRows(
  authorizations: readonly CustomConnectorAgentAuthorization[],
  connectorId: string,
): readonly ConnectorAgentAccessRow[] {
  return authorizations.map(({ agent, access }) => {
    return {
      agent,
      authorized: access.grants.some((grant) => {
        return grant.customConnectorId === connectorId;
      }),
      grants: [],
    };
  });
}

function customConnectorPermissionNamesByAgentId(
  authorizations: readonly CustomConnectorAgentAuthorization[],
  connectorId: string,
): ReadonlyMap<string, readonly string[]> {
  return new Map(
    authorizations.map(({ agent, access }) => {
      return [
        agent.agentId,
        access.grants.find((grant) => {
          return grant.customConnectorId === connectorId;
        })?.permissionNames ?? [],
      ] as const;
    }),
  );
}

function CustomConnectorAccessPermissionsDrawer({
  draft,
  agent,
  connector,
  bundle,
  loading,
  loadError,
  onClose,
}: {
  readonly draft: CustomConnectorPermissionDraft | null;
  readonly agent: AgentResponse | undefined;
  readonly connector: CustomConnectorResponse;
  readonly bundle: CustomConnectorPermissionBundleResponse | null;
  readonly loading: boolean;
  readonly loadError: boolean;
  readonly onClose: () => void;
}) {
  if (!draft || !agent) {
    return null;
  }
  return (
    <CustomConnectorPermissionsDrawer
      agentId={draft.agentId}
      connectorId={connector.id}
      connectorName={connector.displayName}
      agentName={agentName(agent)}
      bundle={bundle}
      loading={loading}
      loadError={loadError}
      onClose={onClose}
    />
  );
}

export function CustomConnectorAccessManagementDialog({
  connector,
  allowAccessIncrease,
  onClose,
}: {
  readonly connector: CustomConnectorResponse;
  readonly allowAccessIncrease: boolean;
  readonly onClose: () => void;
}) {
  const authorizationsLoadable = useLastLoadable(
    customConnectorAgentAuthorizations$,
  );
  const signal = useGet(pageSignal$);
  const permissionDraft = useGet(customConnectorPermissionDraft$);
  const permissionBundleLoadable = useLoadable(
    customConnectorPermissionBundle$,
  );
  const search = useGet(connectorAccessManagementSearch$);
  const setSearch = useSet(setConnectorAccessManagementSearch$);
  const openPermissions = useSet(openCustomConnectorPermissions$);
  const closePermissions = useSet(closeCustomConnectorPermissions$);
  const rowsLoaded = authorizationsLoadable.state === "hasData";
  const authorizations =
    authorizationsLoadable.state === "hasData"
      ? authorizationsLoadable.data
      : [];
  const rows = customConnectorAccessRows(authorizations, connector.id);
  const permissionNamesByAgentId = customConnectorPermissionNamesByAgentId(
    authorizations,
    connector.id,
  );
  const activePermissionDraft =
    permissionDraft?.surface === "access-management" &&
    permissionDraft.connectorId === connector.id
      ? permissionDraft
      : null;
  const permissionAgent = activePermissionDraft
    ? rows.find((row) => {
        return row.agent.agentId === activePermissionDraft.agentId;
      })?.agent
    : undefined;

  const openAgentPermissions = (row: ConnectorAgentAccessRow) => {
    openPermissions(
      {
        surface: "access-management",
        agentId: row.agent.agentId,
        connectorId: connector.id,
        initiallyAuthorized: row.authorized,
        permissionNames: permissionNamesByAgentId.get(row.agent.agentId) ?? [],
      },
      signal,
    );
  };
  const close = () => {
    if (activePermissionDraft) {
      closePermissions();
    }
    setSearch("");
    onClose();
  };

  return (
    <>
      <ConnectorAccessDialog
        onClose={close}
        connectorLabel={connector.displayName}
        headerIcon={
          <CustomConnectorIcon
            id={connector.id}
            displayName={connector.displayName}
            size={22}
          />
        }
        rows={filterRows(rows, search)}
        rowsLoaded={rowsLoaded}
        search={search}
        onSearchChange={setSearch}
        renderRow={(row) => {
          return (
            <CustomAgentAccessRow
              key={row.agent.agentId}
              row={row}
              connector={connector}
              connectorLabel={connector.displayName}
              hasPermissions={Boolean(connector.permissionBundleRef)}
              allowAccessIncrease={allowAccessIncrease}
              onManage={openAgentPermissions}
            />
          );
        }}
      />
      <CustomConnectorAccessPermissionsDrawer
        draft={activePermissionDraft}
        agent={permissionAgent}
        connector={connector}
        bundle={
          permissionBundleLoadable.state === "hasData"
            ? permissionBundleLoadable.data
            : null
        }
        loading={permissionBundleLoadable.state === "loading"}
        loadError={permissionBundleLoadable.state === "hasError"}
        onClose={closePermissions}
      />
    </>
  );
}
