import { LoadErrorRow, surfaceVariants } from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  customConnectors$,
  retryCustomConnectors$,
} from "../../signals/okou-page/settings/custom-connectors.ts";
import { connectedConnectorTargetKeys$ } from "../../signals/okou-page/connector-accounts.ts";
import { reloadUserConnectedConnectors$ } from "../../signals/okou-page/connector-overview.ts";
import {
  agentCustomConnectorGrants$,
  agentAddedCustomConnectors$,
  toggleAgentCustomConnector$,
} from "../../signals/okou-page/job-detail/custom-connectors.ts";
import {
  closeCustomConnectorPermissions$,
  customConnectorPermissionBundle$,
  customConnectorPermissionDraft$,
  openCustomConnectorPermissions$,
} from "../../signals/okou-page/settings/custom-connector-permissions.ts";
import { agentDetail$ } from "../../signals/okou-page/job-detail/detail.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { CustomConnectorIcon } from "../okou-page/components/settings/custom-connector-icon.tsx";
import { ConnectorPermissionRow } from "../okou-page/components/settings/connector-permission-row.tsx";
import { CustomConnectorPermissionsDrawer } from "../okou-page/components/settings/custom-connector-permissions-drawer.tsx";
import { customConnectorTarget } from "../okou-page/components/settings/custom-connector-display.ts";
import { Link } from "../router/link.tsx";

function canAddAgentAccess(connector: CustomConnectorResponse): boolean {
  return connector.connected;
}

function CustomConnectorAccountStatus({
  connector,
  readyForAccess,
}: {
  readonly connector: CustomConnectorResponse;
  readonly readyForAccess: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <span className="font-mono">{customConnectorTarget(connector)}</span>
      {!isIntegrationManagedCustomConnector(connector) && !readyForAccess && (
        <>
          {" · "}
          {t(($) => {
            return $.connectors.accounts.reconnectRequired;
          })}
        </>
      )}
    </>
  );
}

function CustomConnectorReconnectLink({
  connector,
  agentId,
}: {
  readonly connector: CustomConnectorResponse;
  readonly agentId: string;
}) {
  const { t } = useTranslation();
  return (
    <Link
      pathname="/connectors/:connectorSlug/connect"
      options={{
        pathParams: { connectorSlug: connector.slug },
        searchParams: new URLSearchParams({ agentId }),
      }}
      className="shrink-0 text-xs text-primary underline underline-offset-4"
    >
      {t(($) => {
        return $.connectors.actions.reconnect;
      })}
    </Link>
  );
}

function JobCustomConnectorRow({
  connector,
  enabled,
  agentId,
  grants,
  grantsLoading,
  isLast,
}: {
  readonly connector: CustomConnectorResponse;
  readonly enabled: boolean;
  readonly agentId: string | undefined;
  readonly grants: readonly AgentCustomConnectorGrant[] | null;
  readonly grantsLoading: boolean;
  readonly isLast: boolean;
}) {
  const { t } = useTranslation("agents");
  const signal = useGet(pageSignal$);
  const [toggleLoadable, toggle] = useLoadableSet(toggleAgentCustomConnector$);
  const saving = toggleLoadable.state === "loading";
  const readyForAccess = canAddAgentAccess(connector);
  const openPermissions = useSet(openCustomConnectorPermissions$);
  const hasPermissionBundle =
    connector.kind === "http" && Boolean(connector.permissionBundleRef);
  const permissionNames =
    grants?.find((grant) => {
      return grant.customConnectorId === connector.id;
    })?.permissionNames ?? [];

  const openPermissionDrawer = (initiallyAuthorized: boolean) => {
    if (!agentId || !readyForAccess) {
      return;
    }
    openPermissions(
      {
        surface: "agent-detail",
        agentId,
        connectorId: connector.id,
        initiallyAuthorized,
        permissionNames,
      },
      signal,
    );
  };

  return (
    <ConnectorPermissionRow
      icon={
        <CustomConnectorIcon
          id={connector.id}
          displayName={connector.displayName}
          size={20}
        />
      }
      label={connector.displayName}
      labelSuffix={
        !readyForAccess && agentId ? (
          <CustomConnectorReconnectLink
            connector={connector}
            agentId={agentId}
          />
        ) : undefined
      }
      description={
        <CustomConnectorAccountStatus
          connector={connector}
          readyForAccess={readyForAccess}
        />
      }
      enabled={enabled}
      loading={saving || (hasPermissionBundle && grantsLoading)}
      disabled={
        (!enabled && !readyForAccess) ||
        (hasPermissionBundle && grants === null)
      }
      showManage={
        readyForAccess &&
        enabled &&
        hasPermissionBundle &&
        grants !== null &&
        agentId !== undefined
      }
      isLast={isLast}
      onToggle={(checked) => {
        if (checked && !readyForAccess) {
          return;
        }
        if (checked && hasPermissionBundle) {
          if (grants !== null && agentId) {
            openPermissionDrawer(false);
          }
          return;
        }
        if (saving) {
          return;
        }
        detach(
          (async () => {
            await toggle(connector.id, checked, signal);
            toast.success(
              t(($) => {
                return $.authorization.customConnectors.saved;
              }),
            );
          })(),
          Reason.DomCallback,
        );
      }}
      onManage={() => {
        openPermissionDrawer(enabled);
      }}
    />
  );
}

export function JobCustomConnectorsSection() {
  const { t } = useTranslation();
  const connectors = useLoadable(customConnectors$);
  const connectedTargets = useLoadable(connectedConnectorTargetKeys$);
  const retryConnectors = useSet(retryCustomConnectors$);
  const retryConnectedTargets = useSet(reloadUserConnectedConnectors$);
  if (
    connectors.state === "hasError" ||
    connectedTargets.state === "hasError"
  ) {
    return (
      <LoadErrorRow
        message={t(($) => {
          return $.connectors.accounts.accountsUnavailable;
        })}
        retryLabel={t(($) => {
          return $.connectors.actions.tryAgain;
        })}
        onRetry={() => {
          retryConnectors();
          retryConnectedTargets();
        }}
      />
    );
  }
  if (connectors.state !== "hasData" || connectedTargets.state !== "hasData") {
    return (
      <p role="status" className="py-4 text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.catalog.directory.loading;
        })}
      </p>
    );
  }
  const connectedConnectors = connectors.data.filter((connector) => {
    return isIntegrationManagedCustomConnector(connector)
      ? connector.connected
      : connectedTargets.data.has(`custom:${connector.id}`);
  });

  if (connectedConnectors.length === 0) {
    return null;
  }

  return (
    <ConnectedJobCustomConnectorsSection connectors={connectedConnectors} />
  );
}

function ConnectedJobCustomConnectorsSection({
  connectors,
}: {
  readonly connectors: readonly CustomConnectorResponse[];
}) {
  const { t } = useTranslation("agents");
  const addedLoadable = useLastLoadable(agentAddedCustomConnectors$);
  const added = addedLoadable.state === "hasData" ? addedLoadable.data : [];
  const addedSet = new Set(added);
  const permissionDraft = useGet(customConnectorPermissionDraft$);
  const closePermissions = useSet(closeCustomConnectorPermissions$);
  const permissionBundleLoadable = useLoadable(
    customConnectorPermissionBundle$,
  );
  const grantsLoadable = useLastLoadable(agentCustomConnectorGrants$);
  const detail = useLastResolved(agentDetail$);

  const activePermissionDraft =
    permissionDraft?.surface === "agent-detail" &&
    permissionDraft.agentId === detail?.agentId
      ? permissionDraft
      : null;
  const permissionTargetConnector = activePermissionDraft
    ? connectors.find((connector) => {
        return connector.id === activePermissionDraft.connectorId;
      })
    : undefined;
  const permissionTarget =
    activePermissionDraft &&
    permissionTargetConnector &&
    canAddAgentAccess(permissionTargetConnector)
      ? {
          connector: permissionTargetConnector,
          draft: activePermissionDraft,
        }
      : null;
  const permissionBundle =
    permissionBundleLoadable.state === "hasData"
      ? permissionBundleLoadable.data
      : null;

  return (
    <div className={surfaceVariants()}>
      <div className="px-5 pt-4 pb-3 text-sm text-muted-foreground border-b border-border/50">
        {t(($) => {
          return $.authorization.customConnectors.description;
        })}
      </div>
      {connectors.map((connector, index) => {
        return (
          <JobCustomConnectorRow
            key={connector.id}
            connector={connector}
            enabled={addedSet.has(connector.id)}
            agentId={detail?.agentId}
            grants={
              grantsLoadable.state === "hasData" ? grantsLoadable.data : null
            }
            grantsLoading={grantsLoadable.state === "loading"}
            isLast={index === connectors.length - 1}
          />
        );
      })}
      {permissionTarget ? (
        <CustomConnectorPermissionsDrawer
          agentId={permissionTarget.draft.agentId}
          connectorId={permissionTarget.connector.id}
          connectorName={permissionTarget.connector.displayName}
          agentName={
            detail?.displayName ??
            t(($) => {
              return $.fallbackName;
            })
          }
          bundle={permissionBundle}
          loading={permissionBundleLoadable.state === "loading"}
          loadError={permissionBundleLoadable.state === "hasError"}
          onClose={closePermissions}
        />
      ) : null}
    </div>
  );
}
