import { createHmac, timingSafeEqual } from "node:crypto";
import {
  suggestionSchema,
  type Suggestion,
} from "@okouai/api-contracts/contracts/feed";

import { env } from "../../lib/env";
import { safeJsonParse } from "../utils";
import { canonicalJsonString } from "../../lib/canonical-json";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

// The public envelope can change without changing the domain's v1 signature bytes.
function signedSuggestion(suggestion: Suggestion) {
  const item = suggestionSchema.parse(suggestion);
  return {
    ...item.content,
    ...item.state,
    id: item.id,
    priority: item.priority,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt,
  };
}

function consumptionSignature(owner: Owner, suggestion: Suggestion): Buffer {
  // A member may choose a displayed card after its storage lifetime. Bind the
  // cached content to its original owner without retaining expired server data.
  const payload = canonicalJsonString(
    safeJsonParse(
      JSON.stringify([owner.orgId, owner.userId, signedSuggestion(suggestion)]),
    ),
  );
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update("suggestion-consumption:v1:")
    .update(payload)
    .digest();
}

export function withSuggestionConsumeToken(
  owner: Owner,
  suggestion: Suggestion,
) {
  return {
    ...suggestion,
    consumeToken: consumptionSignature(owner, suggestion).toString("hex"),
  };
}

export function hasValidSuggestionConsumeToken(
  owner: Owner,
  suggestion: Suggestion,
): boolean {
  if (
    suggestion.consumeToken === undefined ||
    suggestion.state.status !== "active"
  ) {
    return false;
  }
  const actual = Buffer.from(suggestion.consumeToken, "hex");
  const expected = consumptionSignature(owner, suggestion);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
