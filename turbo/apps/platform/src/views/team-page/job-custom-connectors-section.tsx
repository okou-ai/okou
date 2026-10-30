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
import {
  isIntegrationManagedCustomConnector,
  customConnectorManagedStatusSchema,
} from "@okouai/api-contracts/validators/custom-connectors";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { customConnectors$ } from "../../signals/okou-page/settings/custom-connectors.ts";
import { connectedConnectorTargetKeys$ } from "../../signals/okou-page/connector-accounts.ts";
import {
  agentCustomConnectorGrants$,
  agentAddedCustomConnectors$,
  toggleAgentCustomConnector$,
} from "../../signals/okou-page/job-detail/custom-connectors.ts";
import {
  closeCustomConnectorPermissions$,
  customConnectorPermissionBundle$,
  customConnectorPermissionDraft$,
  prepareCustomConnectorPermissions$,
} from "../../signals/okou-page/settings/custom-connector-permissions.ts";
import { agentDetail$ } from "../../signals/okou-page/job-detail/detail.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, isAbortError, Reason } from "../../signals/utils.ts";
import { CustomConnectorIcon } from "../okou-page/components/settings/custom-connector-icon.tsx";
import { ConnectorPermissionRow } from "../okou-page/components/settings/connector-permission-row.tsx";
import { CustomConnectorPermissionsDrawer } from "../okou-page/components/settings/custom-connector-permissions-drawer.tsx";
import { customConnectorTarget } from "../okou-page/components/settings/custom-connector-display.ts";

interface JobCustomConnectorRowProps {
  readonly connector: CustomConnectorResponse;
  readonly enabled: boolean;
  readonly agentId: string | undefined;
  readonly grants: readonly AgentCustomConnectorGrant[] | null;
  readonly grantsLoading: boolean;
  readonly isLast: boolean;
}

function JobCustomConnectorRow({
  connector,
  enabled,
  agentId,
  grants,
  grantsLoading,
  isLast,
}: JobCustomConnectorRowProps) {
  const signal = useGet(pageSignal$);
  const [toggleLoadable, toggle] = useLoadableSet(toggleAgentCustomConnector$);
  const [permissionsLoadable, openPermissions] = useLoadableSet(
    prepareCustomConnectorPermissions$,
  );
  const saving =
    toggleLoadable.state === "loading" ||
    permissionsLoadable.state === "loading";
  const accessError =
    permissionsLoadable.state === "hasError"
      ? permissionsLoadable.error
      : toggleLoadable.state === "hasError"
        ? toggleLoadable.error
        : null;
  const hasPermissionBundle =
    connector.kind === "http" && Boolean(connector.permissionBundleRef);
  const permissionNames =
    grants?.find((grant) => {
      return grant.customConnectorId === connector.id;
    })?.permissionNames ?? [];

  const openPermissionDrawer = (initiallyAuthorized: boolean) => {
    if (!agentId) {
      return;
    }
    detach(
      openPermissions(
        {
          surface: "agent-detail",
          agentId,
          connector,
          initiallyAuthorized,
          permissionNames,
        },
        signal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <>
      <ConnectorPermissionRow
        icon={
          <CustomConnectorIcon
            id={connector.id}
            displayName={connector.displayName}
            size={20}
          />
        }
        label={connector.displayName}
        description={customConnectorTarget(connector)}
        enabled={enabled}
        loading={saving || (hasPermissionBundle && grantsLoading)}
        disabled={hasPermissionBundle && grants === null}
        showManage={
          enabled &&
          hasPermissionBundle &&
          grants !== null &&
          agentId !== undefined
        }
        isLast={isLast}
        onToggle={(checked) => {
          if (checked && hasPermissionBundle) {
            if (grants !== null && agentId) {
              openPermissionDrawer(false);
            }
            return;
          }
          if (saving) {
            return;
          }
          detach(toggle(connector, checked, signal), Reason.DomCallback);
        }}
        onManage={() => {
          if (!saving) {
            openPermissionDrawer(enabled);
          }
        }}
      />
      {accessError !== null && !isAbortError(accessError) && (
        <p role="alert" className="px-5 pb-3 text-sm text-destructive">
          {String(accessError)}
        </p>
      )}
    </>
  );
}

export function JobCustomConnectorsSection() {
  const { t } = useTranslation();
  const connectors = useLoadable(customConnectors$);
  const connectedTargets = useLoadable(connectedConnectorTargetKeys$);
  if (
    connectors.state === "hasError" ||
    connectedTargets.state === "hasError"
  ) {
    return (
      <LoadErrorRow
        message={t(($) => {
          return $.connectors.accounts.accountsUnavailable;
        })}
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
      ? customConnectorManagedStatusSchema.parse(connector).connected
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
    activePermissionDraft && permissionTargetConnector
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
