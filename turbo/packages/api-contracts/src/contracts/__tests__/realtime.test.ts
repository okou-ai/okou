import { describe, expect, it } from "vitest";

import { userPreferenceChangedPayloadSchema } from "../realtime";

describe("User preference changed contract", () => {
  it("preserves workflow recency and known preferences while ignoring future kinds", () => {
    expect(
      userPreferenceChangedPayloadSchema.parse({
        kinds: ["workflowRecency", "defaultModel", "futurePreference"],
      }),
    ).toStrictEqual({ kinds: ["workflowRecency", "defaultModel"] });
  });
});
