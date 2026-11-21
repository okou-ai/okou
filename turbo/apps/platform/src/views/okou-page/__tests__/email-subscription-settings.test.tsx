import { emailSubscriptionContract } from "@okouai/api-contracts/contracts/email-subscription";
import { screen, within, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
async function openPreferences() {
  await setupPage({
    context,
    path: "/?settings=tools",
    host: "app.okou.ai",
  });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const nav = within(dialog).getByRole("navigation");
  click(
    queryAllByRoleFast("button", nav).find((el) => {
      return el.textContent?.trim() === "Preference";
    })!,
  );
  return screen.findByRole("region", { name: "Email subscriptions" });
}
test("email-subscription-settings-002 a failed save releases the switch for a successful retry", async () => {
  let subscribed = false;
  const failure = context.mocks.deferred<void>();
  context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
    return respond(200, {
      subscribed,
      email: "dispatch@example.com",
      deliveryStatus: "available",
    });
  });
  context.mocks.api(emailSubscriptionContract.update, async ({ respond }) => {
    await failure.promise;
    return respond(500, {
      error: { code: "SERVER_ERROR", message: "Preference save unavailable" },
    });
  });
  const area = await openPreferences(),
    control = await within(area).findByRole("switch", {
      name: "Email updates",
    });
  expect(control).not.toBeChecked();
  click(control);
  await waitFor(() => {
    return expect(control).toHaveAttribute("aria-disabled", "true");
  });
  failure.resolve();
  await waitFor(() => {
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(control).not.toBeChecked();
  });
  context.mocks.api(emailSubscriptionContract.update, ({ body, respond }) => {
    subscribed = body.subscribed;
    return respond(200, { subscribed });
  });
  click(control);
  await waitFor(() => {
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(control).toBeChecked();
  });
});
test("email-subscription-settings-003 unavailable delivery keeps the saved subscription enabled", async () => {
  context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
    return respond(200, {
      subscribed: true,
      email: null,
      deliveryStatus: "no-email",
    });
  });
  const view = within(await openPreferences());
  await expect(
    view.findByText("Email unavailable"),
  ).resolves.toBeInTheDocument();
  expect(view.getByRole("switch", { name: "Email updates" })).toBeChecked();
});
