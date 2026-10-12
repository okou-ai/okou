import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createPublicCreditAlertScenario } from "./helpers/public-credit-alert-scenario";

const context = testContext();

describe("low-credit membership cache public authority", () => {
  it("preserves the first admin across pages and revokes omitted cached membership after a five-credit shared debit", async () => {
    const scenario = await createPublicCreditAlertScenario(context);
    const observation = await scenario.debitWithMemberships("paginated");
    const promoted = await observation.memberAuthority();
    expect(promoted.status).toBe(200);
    const omitted = await observation.adminAuthority();
    expect(omitted.status).toBe(503);
    expect(omitted.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["member", "admin"] as const)(
    "removes cached %s authority when the low-credit refresh receives no memberships",
    async (role) => {
      const scenario = await createPublicCreditAlertScenario(context);
      const observation = await scenario.debitWithMemberships("empty");
      const response =
        role === "member"
          ? await observation.memberAuthority()
          : await observation.adminAuthority();
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
});
