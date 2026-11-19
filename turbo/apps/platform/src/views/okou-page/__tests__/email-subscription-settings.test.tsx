import { emailSubscriptionContract } from "@okouai/api-contracts/contracts/email-subscription";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function openEmailPreferences() {
  await setupPage({ context, path: "/agents?settings=preference" });
  return await screen.findByRole("region", { name: "Email subscriptions" });
}

test("Email updates can be enabled after a failed save", async () => {
  let subscribed = false;
  let rejectNextUpdate = true;
  const releaseFailure = context.mocks.deferred<void>();
  context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
    return respond(200, {
      subscribed,
      email: "reader@example.test",
      deliveryStatus: "available",
    });
  });
  context.mocks.api(
    emailSubscriptionContract.update,
    async ({ body, respond, withSignal }) => {
      if (rejectNextUpdate) {
        rejectNextUpdate = false;
        await withSignal(releaseFailure.promise);
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Email preferences are temporarily unavailable.",
          },
        });
      }
      subscribed = body.subscribed;
      return respond(200, { subscribed });
    },
  );

  const section = await openEmailPreferences();
  const updates = await within(section).findByRole("switch", {
    name: "Email updates",
  });
  expect(updates).not.toBeChecked();

  click(updates);
  await waitFor(() => {
    expect(updates).toHaveAttribute("aria-disabled", "true");
  });
  releaseFailure.resolve(undefined);
  await waitFor(() => {
    expect(updates).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(updates).not.toBeChecked();

  click(updates);
  await waitFor(() => {
    expect(updates).toBeChecked();
  });
});

test("The saved email preference stays on when delivery is unavailable", async () => {
  context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
    return respond(200, {
      subscribed: true,
      email: null,
      deliveryStatus: "no-email",
    });
  });

  const section = await openEmailPreferences();

  await expect(
    within(section).findByText("Email unavailable"),
  ).resolves.toBeInTheDocument();
  expect(
    within(section).getByRole("switch", { name: "Email updates" }),
  ).toBeChecked();
});
