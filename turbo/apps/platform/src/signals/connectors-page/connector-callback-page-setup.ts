import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/client/connectors-slug-callback";
import type { ConnectorOauthCallbackResult } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import {
  connectorNativeAppReturnSchema,
  connectorNativeAppReturnUrl,
} from "@okouai/api-contracts/validators/connectors";
import { customConnectorOAuth2Contract } from "@okouai/api-contracts/client/custom-connectors";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import { integrationOAuthCallbackProvider } from "@okouai/core/integration-routes";
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
import {
  pathParams$,
  pathname$,
  replacePathSilently$,
  searchParams$,
  setupAuthPageWrapper,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { settle } from "../utils.ts";
import { i18n } from "../../i18n/index.ts";
import { connectorIconFromSearchParams } from "./connector-redirecting-page-setup.ts";
import { githubAppSetupCallbackContract } from "@okouai/api-contracts/client/github-oauth-callback";
import { slackOauthCallbackContract } from "@okouai/api-contracts/client/slack-oauth-callback";
import { teamsOauthCallbackContract } from "@okouai/api-contracts/client/teams-oauth-callback";

type ConnectorCallbackPageResult =
  { readonly status: "loading" } | ConnectorOauthCallbackResult;
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
  if (connectorSlug === "link") {
    return i18n.t(($) => {
      return $.connectors.callback.linkLabel;
    });
  }
  if (connectorSlug === "slack") {
    return i18n.t(($) => {
      return $.works.slack.title;
    });
  }
  if (connectorSlug === "microsoft-365") {
    return i18n.t(($) => {
      return $.works.teams.title;
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
  const nativeReturn = connectorNativeAppReturnSchema.safeParse({
    platform: "ios",
    attemptId: searchParams.get("nativeAppAttemptId"),
    httpsHost: searchParams.get("nativeAppHttpsHost") ?? undefined,
  });
  const nativeAppReturn = nativeReturn.success ? nativeReturn.data : undefined;
  if (status === "success") {
    return {
      status,
      username: searchParams.get("username"),
      nativeAppReturn,
    };
  }
  if (status === "error") {
    return {
      status,
      nativeAppReturn,
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
    nativeReturnUrl:
      result.status !== "loading" && result.nativeAppReturn
        ? connectorNativeAppReturnUrl(result.nativeAppReturn)
        : undefined,
  });
}

const loadConnectorCallbackIcon$ = command(
  async (
    { set },
    connectorSlug: ConnectorSlug,
    signal: AbortSignal,
  ): Promise<PublicConnectorCatalogIcon | undefined> => {
    // Link is a native wallet and has no connector catalog entry.
    if (connectorSlug === "link") {
      return undefined;
    }
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
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
    const client = get(apiClient$)(builtinConnectorsSlugCallbackContract, {
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

const completeIntegrationOAuthCallback$ = command(
  async ({ get }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const integration = integrationOAuthCallbackProvider(
      get(pathname$),
      params,
    );
    if (!integration) {
      throw new Error("Invalid integration callback URL");
    }
    const contract =
      integration === "slack"
        ? slackOauthCallbackContract
        : integration === "teams"
          ? teamsOauthCallbackContract
          : githubAppSetupCallbackContract;
    const client = get(apiClient$)(contract, { apiBase: "api" });
    const response = await accept<
      Awaited<ReturnType<typeof client.callback>>,
      200
    >(
      client.callback({
        query: { ...Object.fromEntries(params), responseMode: "json" },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    window.location.assign(response.body.redirectUrl);
  },
);

const setupIntegrationOAuthCallbackPage$ = setupAuthPageWrapper(
  completeIntegrationOAuthCallback$,
);

const showConnectorCallbackResult$ = command(
  async (
    { set },
    args: {
      readonly connectorIcon: PublicConnectorCatalogIcon | undefined;
      readonly connectorSlug: ConnectorSlug | null;
      readonly callbackConnectorSlug: ConnectorCallbackSlug;
      readonly label: string;
      readonly result: ConnectorOauthCallbackResult;
    },
    signal: AbortSignal,
  ) => {
    let { connectorIcon } = args;
    const { connectorSlug, callbackConnectorSlug, label, result } = args;
    if (!connectorIcon && connectorSlug && !result.nativeAppReturn) {
      connectorIcon = await set(
        loadConnectorCallbackIcon$,
        connectorSlug,
        signal,
      );
    }
    set(
      updatePage$,
      callbackPageElement(connectorIcon, connectorSlug, label, result),
    );

    const resultSearchParams = new URLSearchParams();
    if (result.nativeAppReturn) {
      resultSearchParams.set(
        "nativeAppAttemptId",
        result.nativeAppReturn.attemptId,
      );
      if (result.nativeAppReturn.httpsHost) {
        resultSearchParams.set(
          "nativeAppHttpsHost",
          result.nativeAppReturn.httpsHost,
        );
      }
    }
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
    if (result.nativeAppReturn) {
      window.location.assign(
        connectorNativeAppReturnUrl(result.nativeAppReturn),
      );
    }
  },
);

export const setupConnectorCallbackPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const integration = integrationOAuthCallbackProvider(
      get(pathname$),
      get(searchParams$),
    );
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

    if (pathResult && !connectorIcon && connectorSlug) {
      connectorIcon = await set(
        loadConnectorCallbackIcon$,
        connectorSlug,
        signal,
      );
    }
    const initialResult =
      pathResult ??
      (!callbackConnectorSlug
        ? {
            status: "error" as const,
            message: i18n.t(($) => {
              return $.connectors.callback.invalidUrl;
            }),
          }
        : { status: "loading" as const });
    set(
      updatePage$,
      callbackPageElement(connectorIcon, connectorSlug, label, initialResult),
    );
    set(updateDocumentTitle$, connectorCallbackDocumentTitle(label));
    await set(hideAppSkeleton$, signal);
    if (pathResult || !callbackConnectorSlug) {
      return;
    }
    if (integration) {
      await set(setupIntegrationOAuthCallbackPage$, signal);
      return;
    }

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
    await set(
      showConnectorCallbackResult$,
      {
        connectorIcon,
        connectorSlug,
        callbackConnectorSlug,
        label,
        result,
      },
      signal,
    );
  },
);
