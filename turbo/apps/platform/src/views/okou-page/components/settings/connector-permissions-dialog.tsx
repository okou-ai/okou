import { useGet, useSet } from "ccstate-react";
import type {
  createConnectorPermissionsSignals,
  ConnectorPermissionsTarget,
} from "../../../../signals/okou-page/settings/connector-permissions.ts";
import { connectorAccountTargetKey } from "../../../../signals/okou-page/connector-accounts.ts";
import { authenticatedSessionKey$ } from "../../../../signals/auth.ts";
import { PermissionsDialog } from "./permissions-dialog.tsx";

export function ConnectorPermissionsDialog({
  entry,
  signals,
  finalFocus,
}: {
  readonly entry: ConnectorPermissionsTarget;
  readonly signals: ReturnType<typeof createConnectorPermissionsSignals>;
  readonly finalFocus?: HTMLElement | null;
}) {
  const bindDialog = useSet(signals.bindDialog$);
  const initialFocus = useSet(signals.initialFocus$);
  const owner = useGet(authenticatedSessionKey$);
  return (
    <PermissionsDialog
      dialogRef={bindDialog}
      initialFocus={initialFocus}
      finalFocus={
        finalFocus
          ? () => {
              return finalFocus.isConnected ? finalFocus : false;
            }
          : undefined
      }
      connectorScope
      scopeKey={`${owner}:${connectorAccountTargetKey(entry.target)}`}
      connectorSlug={entry.target.connectorSlug}
      connectorLabel={entry.label}
      displayName=""
      session={signals.permissionDrawer}
    />
  );
}
