import { describe, expect, it } from "vitest";
import { SEED_INSTRUCTIONS } from "../seed-instructions";

describe("SEED_INSTRUCTIONS", () => {
  it("limits configuration self-management to custom agents", () => {
    expect(SEED_INSTRUCTIONS).toContain(
      "The workspace default Okou agent is read-only",
    );
    expect(SEED_INSTRUCTIONS).toContain(
      "only custom agents can edit their instructions and profile",
    );
  });
});
