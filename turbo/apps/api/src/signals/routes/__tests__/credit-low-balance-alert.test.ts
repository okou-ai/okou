import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createPublicCreditAlertScenario } from "./helpers/public-credit-alert-scenario";

const context = testContext();

describe("low-credit membership cache public authority", () => {
  it("preserves the first admin across membership pages after a five-credit shared debit", async () => {
    const scenario = await createPublicCreditAlertScenario(context);
    const observation = await scenario.debitWithMemberships("paginated");
    const promoted = await observation.memberAuthority();
    expect(promoted.status).toBe(200);
  });

  it("revokes an omitted cached admin after a five-credit shared debit", async () => {
    const scenario = await createPublicCreditAlertScenario(context);
    const observation = await scenario.debitWithMemberships("paginated");
    const omitted = await observation.adminAuthority();
    expect(omitted.status).toBe(503);
    expect(omitted.headers.get("cache-control")).toBe("no-store");
  });

  it("removes both cached roles when the low-credit refresh receives no memberships", async () => {
    const scenario = await createPublicCreditAlertScenario(context);
    const observation = await scenario.debitWithMemberships("empty");
    const [member, admin] = await Promise.all([
      observation.memberAuthority(),
      observation.adminAuthority(),
    ]);
    expect(member.status).toBe(503);
    expect(member.headers.get("cache-control")).toBe("no-store");
    expect(admin.status).toBe(503);
    expect(admin.headers.get("cache-control")).toBe("no-store");
  });
});
