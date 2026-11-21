import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { billing, setBilling } from "./workspace-billing-fixtures.ts";
const context = testContext();
function account(role: "member" | "admin") {
  const org = { id: "org_arc", name: "Arc Studio", role };
  context.mocks.data.org(org);
  return setupPage({
    context,
    path: "/",
    auth: {
      user: { id: "arc-emil", fullName: "Emil", email: "emil@arc.example" },
      organization: {
        activeOrg: org,
        memberships: [{ id: org.id, role: "org:" + role }],
      },
    },
    sharedWorkerTestTransport: "message-port",
  });
}
async function menu() {
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(await within(rail).findByLabelText("Emil"));
  return screen.findByRole("menu");
}
function creditLedger(read: () => number) {
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: read(),
      purchasedCredits: read(),
      bonusCredits: 0,
      creditGrants: [],
    });
  });
}
test("sidebar-account-credits-001 A member sees the refreshed package balance in the menu and its destination", async () => {
  let personal = 20_400;
  creditLedger(() => {
    return personal;
  });
  setBilling(context, () => {
    return billing("pro", { credits: 89_000 });
  });
  await account("member");
  const first = await menu();
  await expect(
    within(first).findByText("20,400 credits"),
  ).resolves.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(first).not.toBeInTheDocument();
  });
  personal = 500;
  const reopened = await menu();
  click(await within(reopened).findByText("500 credits"));
  await expect(
    screen.findByRole("heading", { name: "Credit balance" }),
  ).resolves.toBeInTheDocument();
  const card = await screen.findByTestId("usage-pack-credit-card");
  await expect(within(card).findByText(/500/)).resolves.toBeInTheDocument();
});
test("sidebar-account-credits-003 Negative workspace credit does not consume Emil's prepaid package", async () => {
  creditLedger(() => {
    return 50_000;
  });
  setBilling(context, () => {
    return billing("pro", { credits: -23_000 });
  });
  await account("admin");
  const panel = await menu();
  await expect(
    within(panel).findByText("50,000 credits"),
  ).resolves.toBeInTheDocument();
});
test("sidebar-account-credits-006 Following the workspace balance opens the funded balance card", async () => {
  setBilling(context, () => {
    return billing("pro", { credits: 12_500, showUsagePack: false });
  });
  await account("admin");
  click(await within(await menu()).findByText("12,500 credits"));
  const settings = await screen.findByRole("dialog");
  await expect(
    within(settings).findByRole("heading", { name: "Credit balance" }),
  ).resolves.toBeInTheDocument();
  await expect(
    within(
      await within(settings).findByTestId("credit-balance-info"),
    ).findByText("12,500"),
  ).resolves.toBeInTheDocument();
});
