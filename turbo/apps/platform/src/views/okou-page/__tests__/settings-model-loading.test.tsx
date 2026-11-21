import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
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
