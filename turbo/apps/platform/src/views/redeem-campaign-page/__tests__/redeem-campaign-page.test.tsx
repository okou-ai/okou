import { billingRedeemContract } from "@okouai/api-contracts/contracts/billing";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
test.each([
  {
    id: "redeem-campaign-page-001",
    reason: "billing_unavailable",
    role: "admin",
    heading: "Billing is temporarily unavailable",
    explanation: "Our payment system isn't available right now.",
  },
  {
    id: "redeem-campaign-page-002",
    reason: "admin_required",
    role: "member",
    heading: "Admin access required",
    explanation:
      "Only organization admins can redeem campaign credits for Default Org. Ask an admin in your org to open the link instead.",
  },
] as const)(
  "$id Opening the campaign reports $heading",
  async ({ reason, role, heading, explanation }) => {
    const campaign = "community-credit";
    context.mocks.data.org({ id: "org_default", name: "Default Org", role });
    context.mocks.api(billingRedeemContract.create, ({ params, respond }) => {
      expect(params.campaign).toBe(campaign);
      return respond(200, { status: "error", reason });
    });
    await setupPage({
      context,
      path: "/redeem/" + campaign,
      auth: {
        user: { id: "visitor", fullName: "Visitor" },
        organization: {
          activeOrg: { id: "org_default", name: "Default Org" },
          memberships: [
            {
              id: "org_default",
              role: role === "member" ? "org:member" : "org:admin",
            },
          ],
        },
      },
    });
    await screen.findByText(heading);
    expect(screen.getByText(explanation)).toBeInTheDocument();
    expect(
      queryAllByRoleFast("link").map((el) => {
        return el.textContent;
      }),
    ).not.toContain("Redeem credits");
  },
);
