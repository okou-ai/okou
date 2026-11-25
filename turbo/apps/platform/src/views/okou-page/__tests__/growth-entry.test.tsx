import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { defaultBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function home(admin: boolean, installed: boolean, connected: boolean) {
  const org = { id: "org_growth", name: "Harbor Studio" };
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, { ...org, role: admin ? "admin" : "member" });
  });
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: connected,
      isInstalled: installed,
      isAdmin: admin,
      workspaceName: installed ? "Harbor Studio" : null,
    });
  });
  await setupPage({
    context,
    path: "/",
    auth: {
      user: { id: "user_harbor", fullName: "Harbor reader" },
      organization: {
        activeOrg: org,
        memberships: [{ id: org.id, role: admin ? "org:admin" : "org:member" }],
      },
    },
  });
}
async function menu() {
  click(await screen.findByTestId("growth-entry-menu"));
  return await screen.findByRole("menu");
}
test("growth-entry-002 workspace credits open the matching credit balance in Settings", async () => {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, { ...defaultBillingStatus(), showUsagePack: true });
  });
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 1600,
      purchasedCredits: 1600,
      bonusCredits: 0,
      creditGrants: [],
    });
  });
  await home(true, true, true);
  const dropdown = await menu();
  const item = await within(dropdown).findByTestId("growth-credits");
  expect(item).toHaveTextContent("1,600");
  click(item);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("heading", { name: "Credit balance" });
  await within(dialog).findByText("1,600");
});
test("growth-entry-003 keyboard activation of the Slack workspace link visits Works and closes the menu", async () => {
  await home(true, true, true);
  const dropdown = await menu();
  const item = await within(dropdown).findByTestId("growth-slack");
  expect(item).toHaveTextContent("Okou is in Slack");
  expect(item.tagName).toBe("A");
  expect(item).toHaveAttribute("href", "/works");
  item.focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(window.location.pathname).toBe("/works");
    expect(dropdown).not.toBeInTheDocument();
  });
  await screen.findByRole("heading", { name: "Where Okou works" });
});
test("growth-entry-005 inviting from a disconnected installation opens People with Add member", async () => {
  await home(true, true, false);
  const dropdown = await menu();
  const invite = await within(dropdown).findByTestId("growth-invite");
  expect(invite).toHaveTextContent("Invite humans");
  click(invite);
  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByRole("heading", { name: "People" }),
  ).resolves.toBeVisible();
  await expect(
    findFastControl("button", "Add member", dialog),
  ).resolves.toBeEnabled();
});
test("growth-entry-007 an ordinary member can compose in a workspace without the admin growth actions", async () => {
  await home(false, false, false);
  await expect(findComposerEditor()).resolves.toBeVisible();
  expect(screen.queryByText("Add Okou in Slack")).toBeNull();
  expect(screen.queryByText(/Invite humans/i)).toBeNull();
  expect(screen.queryByTestId("growth-entry-menu")).toBeNull();
});
