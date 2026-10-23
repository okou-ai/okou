import * as z from "zod";

const oauthScopesSchema = z.array(z.string());

export function resolveOAuthRequestedScopeSnapshot(
  storedScopes: string | null,
  currentRequestedScopes: readonly string[],
): readonly string[] {
  return storedScopes === null
    ? currentRequestedScopes
    : oauthScopesSchema.parse(JSON.parse(storedScopes));
}
