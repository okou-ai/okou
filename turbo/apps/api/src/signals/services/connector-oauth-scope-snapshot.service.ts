import { array, string } from "zod";

const oauthScopesSchema = array(string());

export function resolveOAuthRequestedScopeSnapshot(
  storedScopes: string | null,
  currentRequestedScopes: readonly string[],
): readonly string[] {
  return storedScopes === null
    ? currentRequestedScopes
    : oauthScopesSchema.parse(JSON.parse(storedScopes));
}
