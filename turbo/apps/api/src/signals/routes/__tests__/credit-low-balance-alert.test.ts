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

  it("removes cached organization authority when the low-credit refresh receives no memberships", async () => {
    const scenario = await createPublicCreditAlertScenario(context);
    const observation = await scenario.debitWithMemberships("empty");
    const member = await observation.memberAuthority();
    expect(member.status).toBe(503);
    expect(member.headers.get("cache-control")).toBe("no-store");
    const admin = await observation.adminAuthority();
    expect(admin.status).toBe(503);
    expect(admin.headers.get("cache-control")).toBe("no-store");
  });
});
