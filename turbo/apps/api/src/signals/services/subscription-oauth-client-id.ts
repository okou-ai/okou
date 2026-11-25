import { optionalEnv } from "../../lib/env";

export function subscriptionOAuthClientId(
  name: "CODEX_OAUTH_CLIENT_ID" | "CLAUDE_CODE_OAUTH_CLIENT_ID",
): string {
  const clientId = optionalEnv(name);
  if (!clientId) {
    throw new Error(`${name} is required for subscription authentication`);
  }
  return clientId;
}
