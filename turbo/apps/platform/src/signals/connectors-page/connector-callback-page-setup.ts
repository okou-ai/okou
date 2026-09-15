import {
  connectorsSlugCallbackContract,
  type ConnectorOauthCallbackResult,
} from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { customConnectorOAuth2Contract } from "@okouai/api-contracts/contracts/custom-connectors";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { command } from "ccstate";
import { createElement } from "react";
import { accept } from "../../lib/accept.ts";
import { ConnectorCallbackPage } from "../../views/okou-page/connector-callback-page.tsx";
import { apiClient$ } from "../api-client.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { loadConnectorCatalogItem$ } from "../external/connectors.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$, replacePathSilently$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { settle } from "../utils.ts";
import { i18n } from "../../i18n/index.ts";
import { syncGoogleAdsConversionMilestones$ } from "../bootstrap/google-ads-conversion-milestones.ts";
import { connectorIconFromSearchParams } from "./connector-redirecting-page-setup.ts";

type ConnectorCallbackPageResult =
  | { readonly status: "loading" }
  | ConnectorOauthCallbackResult;
type ConnectorCallbackSlug = ConnectorSlug | "custom";

function connectorSlugFromPath(
  value: string | undefined,
): ConnectorCallbackSlug | null {
  const normalized = value?.toLowerCase();
  if (normalized === "custom") {
    return normalized;
  }
  const parsed = connectorSlugSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function connectorLabel(connectorSlug: ConnectorCallbackSlug | null): string {
  if (!connectorSlug) {
    return i18n.t(($) => {
      return $.connectors.callback.genericLabel;
    });
  }
  if (connectorSlug === "custom") {
    return i18n.t(($) => {
      return $.connectors.callback.customConnectorLabel;
    });
  }
  return connectorSlug === "github"
    ? i18n.t(($) => {
        return $.connectors.callback.githubLabel;
      })
    : connectorSlug === "mercury"
      ? i18n.t(($) => {
          return $.connectors.callback.mercuryLabel;
        })
      : connectorSlug.toUpperCase();
}

function connectorCallbackDocumentTitle(label: string): string {
  return i18n.t(
    ($) => {
      return $.connectors.callback.documentTitle;
    },
    { connector: label },
  );
}

function addConnectorIconSearchParams(
  searchParams: URLSearchParams,
  icon: PublicConnectorCatalogIcon | undefined,
): void {
  if (!icon) {
    return;
  }
  searchParams.set("iconUrl", icon.url);
  searchParams.set("iconInvertInDarkMode", String(icon.invertInDarkMode));
  if (icon.scale !== undefined) {
    searchParams.set("iconScale", String(icon.scale));
  }
}

function resultFromPath(
  status: string | undefined,
  searchParams: URLSearchParams,
): ConnectorOauthCallbackResult | null {
  if (status === "success") {
    return {
      status,
      username: searchParams.get("username"),
    };
  }
  if (status === "error") {
    return {
      status,
      message:
        searchParams.get("message") ||
        i18n.t(($) => {
          return $.connectors.callback.errorFallback;
        }),
    };
  }
  return null;
}

function callbackPageElement(
  connectorIcon: PublicConnectorCatalogIcon | undefined,
  connectorSlug: ConnectorSlug | null,
  label: string,
  result: ConnectorCallbackPageResult,
): React.JSX.Element {
  return createElement(ConnectorCallbackPage, {
    connectorIcon,
    connectorSlug,
    connectorLabel: label,
    status: result.status,
    username: result.status === "success" ? result.username : null,
    errorMessage: result.status === "error" ? result.message : null,
  });
}

const loadConnectorCallbackIcon$ = command(
  async (
    { set },
    connectorSlug: ConnectorSlug,
    signal: AbortSignal,
  ): Promise<PublicConnectorCatalogIcon | undefined> => {
    const catalogItem = await settle(
      set(loadConnectorCatalogItem$, connectorSlug, signal),
      signal,
    );
    return catalogItem.ok ? catalogItem.value?.icon : undefined;
  },
);

const completeConnectorCallback$ = command(
  async (
    { get },
    connectorSlug: ConnectorSlug,
    query: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ConnectorOauthCallbackResult> => {
    const client = get(apiClient$)(connectorsSlugCallbackContract, {
      apiBase: "api",
    });
    const response = await accept(
      client.callback({
        params: { connectorSlug },
        query: { ...query, responseMode: "json" },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return response.body;
  },
);

const completeCustomConnectorCallback$ = command(
  async (
    { get },
    query: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ConnectorOauthCallbackResult> => {
    const client = get(apiClient$)(customConnectorOAuth2Contract, {
      apiBase: "api",
    });
    const response = await accept(
      client.callback({
        query: { ...query, responseMode: "json" },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return response.body;
  },
);

export const setupConnectorCallbackPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$);
    const callbackConnectorSlug = connectorSlugFromPath(
      typeof params?.connectorSlug === "string"
        ? params.connectorSlug
        : undefined,
    );
    const connectorSlug =
      callbackConnectorSlug === "custom" ? null : callbackConnectorSlug;
    const label = connectorLabel(callbackConnectorSlug);
    const searchParams = get(searchParams$);
    let connectorIcon = connectorIconFromSearchParams(searchParams);
    const pathResult = resultFromPath(
      typeof params?.status === "string" ? params.status : undefined,
      searchParams,
    );

    if (pathResult) {
      if (!connectorIcon && connectorSlug) {
        connectorIcon = await set(
          loadConnectorCallbackIcon$,
          connectorSlug,
          signal,
        );
      }
      set(
        updatePage$,
        callbackPageElement(connectorIcon, connectorSlug, label, pathResult),
      );
      set(updateDocumentTitle$, connectorCallbackDocumentTitle(label));
      await set(hideAppSkeleton$, signal);
      return;
    }

    if (!callbackConnectorSlug) {
      set(
        updatePage$,
        callbackPageElement(connectorIcon, connectorSlug, label, {
          status: "error",
          message: i18n.t(($) => {
            return $.connectors.callback.invalidUrl;
          }),
        }),
      );
      set(updateDocumentTitle$, connectorCallbackDocumentTitle(label));
      await set(hideAppSkeleton$, signal);
      return;
    }

    set(
      updatePage$,
      callbackPageElement(connectorIcon, connectorSlug, label, {
        status: "loading",
      }),
    );
    set(updateDocumentTitle$, connectorCallbackDocumentTitle(label));
    await set(hideAppSkeleton$, signal);

    const query = Object.fromEntries(searchParams);
    const result =
      callbackConnectorSlug === "custom"
        ? await set(completeCustomConnectorCallback$, query, signal)
        : await set(
            completeConnectorCallback$,
            callbackConnectorSlug,
            query,
            signal,
          );
    if (!connectorIcon && connectorSlug) {
      connectorIcon = await set(
        loadConnectorCallbackIcon$,
        connectorSlug,
        signal,
      );
    }
    if (result.status === "success") {
      await settle(set(syncGoogleAdsConversionMilestones$, signal), signal);
    }
    set(
      updatePage$,
      callbackPageElement(connectorIcon, connectorSlug, label, result),
    );

    const resultSearchParams = new URLSearchParams();
    if (result.status === "success" && result.username) {
      resultSearchParams.set("username", result.username);
    }
    if (result.status === "error") {
      resultSearchParams.set("message", result.message);
    }
    addConnectorIconSearchParams(resultSearchParams, connectorIcon);
    set(
      replacePathSilently$,
      ROUTES.connectorCallbackResult,
      { connectorSlug: callbackConnectorSlug, status: result.status },
      resultSearchParams,
    );
  },
);
