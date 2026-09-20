import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import { computed } from "ccstate";
import { generateRouterPath } from "../route.ts";
import { ROUTES } from "../route-paths.ts";

export type ConnectorRedirectingStatus = "redirecting" | "error";

export const connectorRedirectingMobileHintVisible$ = computed(() => {
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
});

export function connectorRedirectingPath(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly icon: PublicConnectorCatalogIcon;
  readonly status?: ConnectorRedirectingStatus;
}): string {
  const pathname = generateRouterPath(ROUTES.connectorRedirecting, {
    connectorSlug: args.connectorSlug,
  });
  const searchParams = new URLSearchParams({
    label: args.label,
    iconUrl: args.icon.url,
    iconInvertInDarkMode: String(args.icon.invertInDarkMode),
  });
  if (args.icon.scale !== undefined) {
    searchParams.set("iconScale", String(args.icon.scale));
  }
  if (args.status === "error") {
    searchParams.set("status", args.status);
  }
  return `${pathname}?${searchParams.toString()}`;
}
