import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const fullUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The UUID requirement belongs to shared test identity ownership, not the
// production Stripe ID format. Entitlements are created and read through APIs.
describe("Stripe-backed billing entitlement fixtures", () => {
  it.each(["pro", "team"] as const)(
    "grants %s with full-UUID Stripe identities",
    async (tier) => {
      const actor = bdd.user();
      const granted = await runs.grantProEntitlement(actor, { tier });
      const suffix = granted.invoiceId.slice("in_bdd_".length);

      expect(suffix).toMatch(fullUuidPattern);
      expect(granted.customerId).toBe(`cus_bdd_${suffix}`);
      expect(granted.subscriptionId).toBe(`sub_bdd_${suffix}`);
      await expect(runs.readBillingStatus(actor)).resolves.toMatchObject({
        tier,
        hasSubscription: true,
      });
    },
  );

  it("preserves explicit customer and subscription bindings", async () => {
    const actor = bdd.user();
    const customerId = `cus_fixture_${randomUUID()}`;
    const subscriptionId = `sub_fixture_${randomUUID()}`;

    const granted = await runs.grantProEntitlement(actor, {
      customerId,
      subscriptionId,
    });

    expect(granted).toMatchObject({ customerId, subscriptionId });
    await expect(runs.readBillingStatus(actor)).resolves.toMatchObject({
      tier: "pro",
      hasSubscription: true,
    });
  });

  it("reports owned identities and billing state when a customer belongs to another org", async () => {
    const owner = bdd.user();
    const other = bdd.user();
    const granted = await runs.grantProEntitlement(owner);
    const subscriptionId = `sub_fixture_${randomUUID()}`;

    await expect(
      runs.grantProEntitlement(other, {
        customerId: granted.customerId,
        subscriptionId,
      }),
    ).rejects.toMatchObject({
      message: "Entitlement grant did not reach pro tier: limited-free-1",
      cause: {
        orgId: other.orgId,
        customerId: granted.customerId,
        subscriptionId,
        invoiceId: expect.stringMatching(
          /^in_bdd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
        billingStatus: {
          tier: "limited-free-1",
          hasSubscription: false,
          credits: 0,
        },
      },
    });
    await expect(runs.readBillingStatus(owner)).resolves.toMatchObject({
      tier: "pro",
      hasSubscription: true,
    });
    await expect(runs.readBillingStatus(other)).resolves.toMatchObject({
      tier: "limited-free-1",
      hasSubscription: false,
    });
  });
});
