import type { ConnectorAuthMethodRuntimeConfig } from "@okouai/connectors/connector-config";
import { buildConnectorOpenIdAuthAuthorizationUrlWithMethod } from "@okouai/connectors/auth-providers";
import type { AuthUrlResult } from "@okouai/connectors/auth-providers/provider-flow-types";

import { generateConnectorOAuthState } from "../../lib/connector-oauth-state";

type PrepareResolvedBuiltinConnectorOpenIdAuthStartResult = {
  readonly ok: true;
  readonly state: string;
  readonly returnTo: string;
  readonly realm: string;
  readonly expectedReturnTo: string;
};

function normalizeAuthUrlResult(result: string | AuthUrlResult): AuthUrlResult {
  return typeof result === "string" ? { url: result } : result;
}

export function openIdRealmForOrigin(origin: string): string {
  const url = new URL(origin);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function prepareBuiltinConnectorOpenIdAuthStartWithMethod(args: {
  readonly connectorSlug: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly origin: string;
}): PrepareResolvedBuiltinConnectorOpenIdAuthStartResult {
  if (args.method.grant.kind !== "openid-auth") {
    throw new Error("OpenID auth method required");
  }
  const state = generateConnectorOAuthState();
  const returnTo = new URL(
    `/api/connectors/${args.connectorSlug}/callback`,
    args.origin,
  );
  returnTo.searchParams.set("state", state);
  return {
    ok: true,
    state,
    returnTo: returnTo.toString(),
    expectedReturnTo: returnTo.toString(),
    realm: openIdRealmForOrigin(args.origin),
  };
}

export async function buildBuiltinConnectorOpenIdAuthUrlWithMethod(args: {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly returnTo: string;
  readonly realm: string;
  readonly state: string;
}): Promise<AuthUrlResult> {
  return normalizeAuthUrlResult(
    await buildConnectorOpenIdAuthAuthorizationUrlWithMethod({
      connectorSlug: args.connectorSlug,
      authMethodId: args.authMethodId,
      method: args.method,
      returnTo: args.returnTo,
      realm: args.realm,
      state: args.state,
    }),
  );
}
