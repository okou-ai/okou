import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/client/third-party-subscriptions";
import { personalAccount } from "./personal-account-settings-fixtures.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { mockNow } from "../../../lib/time.ts";
import { screen, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { defaultBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
async function accountMenu() {
  click(await findAction("button", "Test User"));
  return screen.findByRole("menu");
}
test("settings-model-loading-003 a billing notification updates the reopened balance view and the account menu", async () => {
  let credits = 20_000;
  let paused = false;
  const reading = context.mocks.deferred<void>();
  const resume = context.mocks.deferred<void>();
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    const balance = credits;
    if (paused) {
      reading.resolve();
      await resume.promise;
    }
    return respond(200, { ...defaultBillingStatus(), credits: balance });
  });
  await setupPage({ context, path: "/?settings=model" });
  const initial = await screen.findByRole("dialog", { name: "Settings" });
  await within(initial).findByRole("heading", { name: "Use more models" });
  click(getAction("button", "Close", initial));
  const menu = await accountMenu();
  await within(menu).findByText("20,000 credits");
  click(within(menu).getByText("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(await findAction("button", "Models", settings));
  await within(settings).findByRole("heading", { name: "Use more models" });
  paused = true;
  context.mocks.ably.trigger("billing:changed");
  await reading.promise;
  click(getAction("button", "Credit balance", settings));
  await within(settings).findByRole("heading", { name: "Credit balance" });
  paused = false;
  resume.resolve();
  await within(settings).findByText("20,000", { exact: true });
  credits = 25_000;
  context.mocks.ably.trigger("billing:changed");
  await expect(
    within(settings).findByText("25,000", { exact: true }),
  ).resolves.toBeVisible();
  click(getAction("button", "Close", settings));
  const after = await accountMenu();
  await expect(
    within(after).findByText("25,000 credits"),
  ).resolves.toBeVisible();
});

test("Reopening Models while both reads are pending shows the account loading state until the subscription arrives", async () => {
  const resume = context.mocks.deferred<void>();
  const refreshing = context.mocks.deferred<void>();
  const accountRead = context.mocks.deferred<void>();
  const confirmAccount = context.mocks.deferred<void>();
  const member = personalAccount("ChatGPT", 4);
  let clock = new Date("2026-06-18T10:00:00Z").getTime();
  mockNow(() => {
    return clock;
  }, context.signal);
  let suspend = false;
  context.mocks.api(
    thirdPartySubscriptionsMainContract.list,
    async ({ respond }) => {
      if (!suspend) {
        return respond(200, { subscriptions: [] });
      }
      accountRead.resolve();
      await confirmAccount.promise;
      return respond(200, { subscriptions: [member] });
    },
  );
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    if (suspend) {
      refreshing.resolve();
      await resume.promise;
    }
    return respond(200, defaultBillingStatus());
  });
  try {
    await setupPage({
      context,
      path: "/?settings=model",
      featureSwitches: { [FeatureSwitchKey.SubscriptionLinkingEntry]: true },
    });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await expect(
      findAction("button", "Connect account", dialog),
    ).resolves.toBeEnabled();
    click(getAction("button", "Close", dialog));
    clock += 120_000;
    suspend = true;
    const menu = await accountMenu();
    await accountRead.promise;
    click(within(menu).getByText("Settings"));
    const reopened = await screen.findByRole("dialog", { name: "Settings" });
    click(getAction("button", "Preference", reopened));
    await within(reopened).findByRole("heading", { name: "Preference" });
    context.mocks.ably.trigger("billing:changed");
    click(getAction("button", "Models", reopened));
    await refreshing.promise;
    expect(
      within(reopened).queryByRole("heading", { name: "Models" }),
    ).toBeNull();
    await expect(
      within(reopened).findByRole("heading", { name: "Use more models" }),
    ).resolves.toBeInTheDocument();
    await within(reopened).findByRole("status", { name: "Loading accounts…" });
    expect(within(reopened).queryByText("No accounts connected.")).toBeNull();
    expect(within(reopened).queryAllByText("Connect account")).toHaveLength(0);
    confirmAccount.resolve();
    await within(reopened).findByText("member4@example.test");
  } finally {
    if (!confirmAccount.settled()) {
      confirmAccount.resolve();
    }
    resume.resolve();
  }
});

test("Returning to model settings presents account setup while the updated balance is held", async () => {
  const resume = context.mocks.deferred<void>();
  const refreshing = context.mocks.deferred<void>();
  let suspend = false;
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    if (suspend) {
      refreshing.resolve();
      await resume.promise;
    }
    return respond(200, defaultBillingStatus());
  });
  try {
    await setupPage({ context, path: "/?settings=model" });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await expect(
      findAction("button", "Connect account", dialog),
    ).resolves.toBeEnabled();
    click(getAction("button", "Preference", dialog));
    await within(dialog).findByRole("heading", { name: "Preference" });
    suspend = true;
    context.mocks.ably.trigger("billing:changed");
    click(getAction("button", "Models", dialog));
    await refreshing.promise;
    expect(
      within(dialog).queryByRole("heading", { name: "Models" }),
    ).toBeNull();
    await expect(
      within(dialog).findByRole("heading", { name: "Use more models" }),
    ).resolves.toBeInTheDocument();
    await expect(
      findAction("button", "Connect account", dialog),
    ).resolves.toBeEnabled();
    for (const name of ["Claude", "ChatGPT (Codex)"]) {
      const provider = within(dialog).getByRole("heading", {
        name,
      }).parentElement!;
      expect(
        within(provider).getByText("No accounts connected."),
      ).toBeInTheDocument();
    }
  } finally {
    resume.resolve();
  }
});
