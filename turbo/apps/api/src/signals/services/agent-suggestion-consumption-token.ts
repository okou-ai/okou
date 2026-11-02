import { createHmac, timingSafeEqual } from "node:crypto";
import {
  suggestionSchema,
  type Suggestion,
} from "@okouai/api-contracts/contracts/suggestions";

import { env } from "../../lib/env";
import { safeJsonParse } from "../utils";
import { canonicalJsonString } from "../../lib/canonical-json";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

const snapshotSchema = suggestionSchema.omit({ consumeToken: true });

function consumptionSignature(owner: Owner, suggestion: Suggestion): Buffer {
  // A member may choose a displayed card after its storage lifetime. Bind the
  // cached content to its original owner without retaining expired server data.
  const payload = canonicalJsonString(
    safeJsonParse(
      JSON.stringify([
        owner.orgId,
        owner.userId,
        snapshotSchema.parse(suggestion),
      ]),
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
  if (suggestion.consumeToken === undefined || suggestion.status !== "active") {
    return false;
  }
  const actual = Buffer.from(suggestion.consumeToken, "hex");
  const expected = consumptionSignature(owner, suggestion);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
