import {
  resolveConnectorAuthClient,
  type ConnectorAuthClient,
  type ConnectorEnvReader,
} from "@okouai/connectors/connector-auth-method";
import type { ConnectorAuthMethodRuntimeConfig } from "@okouai/connectors/connector-config";
import { buildConnectorAuthCodeAuthorizationUrlWithMethod } from "@okouai/connectors/auth-providers";
import type { AuthUrlResult } from "@okouai/connectors/auth-providers/provider-flow-types";

import { generateConnectorOAuthState } from "../../lib/connector-oauth-state";

function normalizeAuthUrlResult(result: string | AuthUrlResult): AuthUrlResult {
  return typeof result === "string" ? { url: result } : result;
}

type PrepareBuiltinConnectorAuthCodeStartWithMethodResult =
  | {
      readonly ok: true;
      readonly state: string;
      readonly redirectUri: string;
      readonly authClient: ConnectorAuthClient;
    }
  | {
      readonly ok: false;
      readonly reason: "auth_client_not_configured" | "wrong_grant_kind";
    };

export function prepareBuiltinConnectorAuthCodeStartWithMethod(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly redirectUri: string;
  readonly readEnv: ConnectorEnvReader;
}): PrepareBuiltinConnectorAuthCodeStartWithMethodResult {
  if (args.method.grant.kind !== "auth-code" || !args.method.client) {
    return { ok: false, reason: "wrong_grant_kind" };
  }
  const authClient = resolveConnectorAuthClient(
    args.method.client,
    args.readEnv,
  );
  if (!authClient) {
    return { ok: false, reason: "auth_client_not_configured" };
  }
  const state = generateConnectorOAuthState();
  return {
    ok: true,
    state,
    redirectUri: args.redirectUri,
    authClient,
  };
}

export async function buildBuiltinConnectorAuthCodeAuthUrlWithMethod(args: {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly authClient: ConnectorAuthClient;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<AuthUrlResult> {
  return normalizeAuthUrlResult(
    await buildConnectorAuthCodeAuthorizationUrlWithMethod({
      connectorSlug: args.connectorSlug,
      authMethodId: args.authMethodId,
      method: args.method,
      authClient: args.authClient,
      redirectUri: args.redirectUri,
      state: args.state,
    }),
  );
}
