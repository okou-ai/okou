import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  publicConnectorCatalogIconSchema,
  type PublicConnectorCatalogIcon,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { ConnectorRedirectingPage } from "../../views/okou-page/connector-redirecting-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import {
  resetConnectorRedirectingMobileWarning$,
  showConnectorRedirectingMobileWarningAfterDelay$,
  type ConnectorRedirectingStatus,
} from "./connector-redirecting.ts";

function connectorSlugFromPath(
  value: string | undefined,
): ConnectorSlug | null {
  const parsed = connectorSlugSchema.safeParse(value?.toLowerCase());
  return parsed.success ? parsed.data : null;
}

export function connectorIconFromSearchParams(
  searchParams: URLSearchParams,
): PublicConnectorCatalogIcon | undefined {
  const url = searchParams.get("iconUrl");
  const invertInDarkMode = searchParams.get("iconInvertInDarkMode");
  if (!url || (invertInDarkMode !== "true" && invertInDarkMode !== "false")) {
    return undefined;
  }
  const scale = searchParams.get("iconScale");
  const parsed = publicConnectorCatalogIconSchema.safeParse({
    url,
    invertInDarkMode: invertInDarkMode === "true",
    ...(scale === null ? {} : { scale: Number(scale) }),
  });
  return parsed.success ? parsed.data : undefined;
}

export const setupConnectorRedirectingPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$);
    const connectorSlug = connectorSlugFromPath(
      typeof params?.connectorSlug === "string"
        ? params.connectorSlug
        : undefined,
    );
    const searchParams = get(searchParams$);
    const connectorLabel =
      searchParams.get("label")?.trim() || connectorSlug || "connector";
    const status: ConnectorRedirectingStatus =
      searchParams.get("status") === "error" ? "error" : "redirecting";
    const connectorIcon = connectorIconFromSearchParams(searchParams);

    set(resetConnectorRedirectingMobileWarning$);
    set(
      updatePage$,
      createElement(ConnectorRedirectingPage, {
        connectorSlug,
        connectorLabel,
        connectorIcon,
        status,
      }),
    );
    set(
      updateDocumentTitle$,
      i18n.t(
        ($) => {
          return $.connectors.callback.documentTitle;
        },
        { connector: connectorLabel },
      ),
    );
    await set(hideAppSkeleton$, signal);
    if (status === "redirecting") {
      await set(showConnectorRedirectingMobileWarningAfterDelay$, signal);
    }
  },
);
