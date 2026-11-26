import { optionalEnv } from "../../lib/env";

/** Google's token endpoint for the official Antigravity OAuth client. */
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Both values come from deployment config; neither is committed. */
export function antigravityOAuthClient() {
  const clientId = optionalEnv("ANTIGRAVITY_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
