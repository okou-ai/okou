import { useGet } from "ccstate-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { managedConnectorAccessSignals$ } from "../../../../signals/okou-page/settings/connector-access-management.ts";
import { ConnectorPermissionsDialog } from "./connector-permissions-dialog.tsx";

export function ConnectorAccessManagementDialog(props: {
  readonly connectorSlug: ConnectorSlug;
  readonly connectorLabel: string;
}) {
  const signals = useGet(managedConnectorAccessSignals$);
  const entry = {
    target: { kind: "builtin" as const, connectorSlug: props.connectorSlug },
    label: props.connectorLabel,
  };
  return (
    signals && <ConnectorPermissionsDialog entry={entry} signals={signals} />
  );
}
