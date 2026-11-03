import { useGet, useLoadable, useSet } from "ccstate-react";
import type {
  createConnectorPermissionsSignals,
  ConnectorPermissionsTarget,
} from "../../../../signals/okou-page/settings/connector-permissions.ts";
import { activeUserPermissionGrantSnapshot } from "../../../../signals/user-permission-grants.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { connectorAccountTargetKey } from "../../../../signals/okou-page/connector-accounts.ts";
import { authenticatedSessionKey$ } from "../../../../signals/auth.ts";
import { PermissionsDialog } from "./permissions-dialog.tsx";

export function ConnectorPermissionsDialog({
  entry,
  signals,
  onClose,
}: {
  readonly entry: ConnectorPermissionsTarget;
  readonly signals: ReturnType<typeof createConnectorPermissionsSignals>;
  readonly onClose: () => void;
}) {
  const grants = useLoadable(signals.grants$);
  const save = useSet(signals.save$);
  const signal = useGet(pageSignal$);
  const owner = useGet(authenticatedSessionKey$);
  const snapshot =
    grants.state === "hasData" && grants.data
      ? activeUserPermissionGrantSnapshot(grants.data)
      : null;
  return (
    <PermissionsDialog
      connectorScope
      scopeKey={`${owner}:${connectorAccountTargetKey(entry.target)}`}
      connectorSlug={entry.target.connectorSlug}
      connectorLabel={entry.label}
      displayName=""
      metadata$={signals.editorMetadata$}
      initialPolicies={snapshot?.policies ?? {}}
      initialGrants={snapshot?.grants ?? []}
      readOnly={!snapshot}
      onApply={async (intent) => {
        if (snapshot) {
          await save(
            {
              initialPolicies: snapshot.policies ?? {},
              initialGrants: snapshot.grants,
              intent,
            },
            signal,
          );
        }
      }}
      onClose={onClose}
    />
  );
}
