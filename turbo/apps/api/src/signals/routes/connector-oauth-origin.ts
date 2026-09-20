import {
  connectorAuthCodeGrantCallbackOrigin,
  connectorOpenIdAuthGrantCallbackOrigin,
} from "@okouai/connectors/connector-auth-method";
import { isConnectorAppOauthCallbackEnabled } from "@okouai/connectors/app-oauth-callback";
import type {
  ConnectorAuthMethodRuntimeConfig,
  ConnectorBrowserAuthCallbackOrigin,
} from "@okouai/connectors/connector-config";

import { env } from "../../lib/env";
import {
  getOAuthApiOrigin,
  getOAuthCanonicalRedirectUrl,
  getOAuthWebOrigin,
} from "../../lib/oauth-origin";

export { getOAuthWebOrigin as getBuiltinConnectorOAuthOrigin };

function resolveCallbackOrigin(
  request: Request,
  callbackOrigin: ConnectorBrowserAuthCallbackOrigin,
): string {
  switch (callbackOrigin) {
    case "api": {
      return getOAuthApiOrigin(request);
    }
    case "web": {
      return getOAuthWebOrigin(request);
    }
  }
}

export function getBuiltinConnectorOAuthCallbackUrlForMethod(args: {
  readonly request: Request;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly connectorSlug: string;
  readonly callbackTarget: "app" | undefined;
}): string {
  if (args.method.grant.kind !== "auth-code") {
    throw new Error("Auth-code connector method required");
  }
  const callbackOrigin = connectorAuthCodeGrantCallbackOrigin(
    args.method.grant,
  );
  if (
    args.callbackTarget === "app" &&
    isConnectorAppOauthCallbackEnabled(args.connectorSlug)
  ) {
    return new URL(
      `/connectors/${encodeURIComponent(args.connectorSlug)}/callback`,
      env("APP_URL"),
    ).toString();
  }
  return new URL(
    `/api/connectors/${encodeURIComponent(args.connectorSlug)}/callback`,
    resolveCallbackOrigin(args.request, callbackOrigin),
  ).toString();
}

export function getBuiltinConnectorOpenIdCallbackOriginForMethod(args: {
  readonly request: Request;
  readonly method: ConnectorAuthMethodRuntimeConfig;
}): string {
  if (args.method.grant.kind !== "openid-auth") {
    throw new Error("OpenID connector method required");
  }
  return resolveCallbackOrigin(
    args.request,
    connectorOpenIdAuthGrantCallbackOrigin(args.method.grant),
  );
}

export function getBuiltinConnectorOAuthCanonicalRedirectUrlForMethods(
  request: Request,
  methods: readonly ConnectorAuthMethodRuntimeConfig[],
): string | null {
  const authCodeMethods = methods.filter(
    (
      method,
    ): method is Extract<
      ConnectorAuthMethodRuntimeConfig,
      { readonly grant: { readonly kind: "auth-code" } }
    > => {
      return method.grant.kind === "auth-code";
    },
  );
  if (
    authCodeMethods.every((method) => {
      return connectorAuthCodeGrantCallbackOrigin(method.grant) === "api";
    })
  ) {
    return null;
  }
  return getOAuthCanonicalRedirectUrl(request);
}
