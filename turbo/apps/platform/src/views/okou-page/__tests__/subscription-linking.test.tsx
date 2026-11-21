import { screen, within, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import {
  personalAccount,
  serveClaudeLogin,
  serveCodexLogin,
  approvalUrl,
  usageWindow,
} from "./personal-account-settings-fixtures.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import { findComposer } from "./chat-message-experience-test-helpers.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
const context = testContext();
async function home(enabled = true) {
  await setupPage({
    context,
    path: "/",
    featureSwitches: { [FeatureSwitchKey.SubscriptionLinkingEntry]: enabled },
  });
  return findComposer();
}
async function accountMenu() {
  click(await findAction("button", "Test User"));
  return screen.findByRole("menu");
}
function linked(needsReconnect = false) {
  const member = personalAccount("ChatGPT", 1, {
    needsReconnect,
    subscriptionUsage: {
      fiveHour: usageWindow(0, 18_000),
      weekly: usageWindow(70, 604_800),
    },
  });
  context.mocks.data.personalModelProviders([member]);
  context.mocks.data.availableRunModels([
    buildRunModel({ model: null }),
    buildRunModel({
      model: "gpt-6-luna",
      modelLabel: "GPT 6 Luna",
      providerType: "codex-oauth-token",
      modelProviderId: member.id,
    }),
  ]);
  return member;
}
async function plans() {
  click(await findAction("button", "Use more models"));
  return screen.findByRole("menu", { name: "Use more models" });
}
test("subscription-linking-001 the composer offers Auto credits and the two eligible personal plans", async () => {
  await home();
  await expect(
    screen.findByLabelText("Explore Okou capabilities"),
  ).resolves.toBeInTheDocument();
  const menu = within(await plans());
  expect(
    menu.getByLabelText("Auto", { selector: '[role="menuitemradio"]' }),
  ).toHaveAccessibleDescription("Uses Okou credits");
  expect(
    menu.getByLabelText("Claude", { selector: '[role="menuitem"]' }),
  ).toHaveAccessibleDescription("Pro or Max");
  expect(
    menu.getByLabelText("ChatGPT (Codex)", { selector: '[role="menuitem"]' }),
  ).toHaveAccessibleDescription("Plus, Pro or Business");
  expect(menu.getByText("Run on your own plan")).toBeVisible();
});
test("subscription-linking-002 completing Codex returns to Auto without replacing the draft", async () => {
  serveCodexLogin(context);
  const approved = context.mocks.deferred<void>();
  context.mocks.api(codexDeviceAuthContract.complete, async ({ respond }) => {
    await approved.promise;
    return respond(200, {
      status: "complete",
      created: true,
      provider: linked(),
    });
  });
  const composer = await home();
  await fill(composer, "Keep this draft");
  click(
    within(await plans()).getByLabelText("ChatGPT (Codex)", {
      selector: '[role="menuitem"]',
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  await within(dialog).findByText("PLAN-8261");
  approved.resolve();
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  await expect(composerModelTrigger("Auto")).resolves.toBeEnabled();
  expect(composer).toHaveTextContent("Keep this draft");
  expect(
    screen.queryByLabelText("Use more models", { selector: "button" }),
  ).toBeNull();
  expect(within(await accountMenu()).queryByText("Use more models")).toBeNull();
});
test("subscription-linking-003 the ChatGPT five-hour limit is visible before authorizing the other plan", async () => {
  linked();
  serveClaudeLogin(context);
  await home();
  click(await composerModelTrigger("Auto"));
  const panel = within(
    await screen.findByRole("dialog", { name: "Chat models" }),
  );
  expect(panel.getByText("Your ChatGPT plan")).toBeVisible();
  expect(panel.getByText("Your Claude plan")).toBeVisible();
  const quota = await panel.findByText("0% left");
  expect(quota.parentElement).toHaveTextContent("5h · 0% left");
  click(panel.getByLabelText("Claude", { selector: "button" }));
  const auth = await screen.findByRole("dialog", { name: "Connect Claude" });
  await expect(
    findAction("link", "Open Claude approval page", auth),
  ).resolves.toHaveAttribute("href", approvalUrl);
});
test("subscription-linking-004 Manage plans takes the member from the picker into Models settings", async () => {
  linked();
  await home();
  click(await composerModelTrigger("Auto"));
  const panel = await screen.findByRole("dialog", { name: "Chat models" });
  click(getAction("button", "Manage plans", panel));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await within(settings).findByRole("heading", { name: "Use more models" });
  expect(new URL(location.href).searchParams.get("settings")).toBe("model");
});
test("subscription-linking-005 cancelling Claude approval keeps the account menu entry", async () => {
  serveClaudeLogin(context);
  await home();
  const menu = within(await accountMenu());
  click(menu.getByText("Use more models"));
  click(await screen.findByText("Claude", { exact: true }));
  const auth = await screen.findByRole("dialog", { name: "Connect Claude" });
  await expect(
    findAction("link", "Open Claude approval page", auth),
  ).resolves.toHaveAttribute("href", approvalUrl);
  click(getAction("button", "Close", auth));
  await waitFor(() => {
    return expect(auth).not.toBeInTheDocument();
  });
  await expect(
    within(await accountMenu()).findByText("Use more models"),
  ).resolves.toBeVisible();
});
test("subscription-linking-007 expired Codex retains its picker and subscription usage entry", async () => {
  linked(true);
  await home();
  click(await composerModelTrigger("Auto"));
  const panel = await screen.findByRole("dialog", { name: "Chat models" });
  expect(within(panel).queryByText("Use more models")).toBeNull();
  await userEvent.setup().keyboard("{Escape}");
  const menu = await accountMenu();
  expect(within(menu).queryByText("Use more models")).toBeNull();
  await userEvent.setup().keyboard("{Escape}");
  click(
    await screen.findByLabelText(/^Subscription usage/u, {
      selector: "button",
    }),
  );
  await expect(
    screen.findByLabelText("ChatGPT usage", { selector: "section" }),
  ).resolves.toBeVisible();
});
test("subscription-linking-008 disabling linking preserves capability exploration", async () => {
  await home(false);
  await expect(
    screen.findByLabelText("Explore Okou capabilities"),
  ).resolves.toBeInTheDocument();
  const menu = await accountMenu();
  expect(within(menu).queryByText("Use more models")).toBeNull();
  expect(
    screen.queryByLabelText("Use more models", { selector: "button" }),
  ).toBeNull();
});
