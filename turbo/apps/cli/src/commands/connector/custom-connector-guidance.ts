import { uuid } from "zod";

export function customConnectorIdFromSelector(
  selector: string | undefined,
): string | undefined {
  if (!selector?.startsWith("custom:")) {
    return undefined;
  }
  const id = uuid().safeParse(selector.slice("custom:".length));
  if (!id.success) {
    throw new Error(
      "Custom connector selectors must use custom:<uuid>. Run okou connector custom list to find the connector ID.",
    );
  }
  return id.data;
}

export function customConnectorSettingsGuidance(
  customConnectorId: string,
  platformOrigin: string,
  permission?: string,
): string {
  const url = new URL("/connectors", platformOrigin).toString();
  const steps =
    permission === undefined
      ? "Review its accounts and agent access. Reconnect or select an available account as needed."
      : permission === "__unknown__"
        ? "There is no custom unknown-endpoint approval control. Ask an administrator to review the connector's routing and permission definition."
        : "Open the custom connector's agent access management, select the affected agent, and review Permissions.";
  return `Custom connector ${customConnectorId} uses the existing connector settings flow, not a builtin permission approval link.\nOpen [Connectors](${url}) and select this custom connector. ${steps}`;
}
