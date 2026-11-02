import type { Suggestion } from "../contracts/suggestions";

export const SUGGESTION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** An explicit deadline can shorten the 24-hour window after the last update. */
export function getSuggestionExpiresAt(
  suggestion: Pick<Suggestion, "updatedAt" | "expiresAt">,
): number {
  const maximum = Date.parse(suggestion.updatedAt) + SUGGESTION_RETENTION_MS;
  return suggestion.expiresAt === undefined
    ? maximum
    : Math.min(maximum, Date.parse(suggestion.expiresAt));
}
