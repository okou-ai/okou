import { emailUnsubscribeContract } from "@okouai/api-contracts/client/email-unsubscribe";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function confirmUnsubscribe(): Promise<void> {
  const confirm = await waitFor(() => {
    const button = queryAllByRoleFast("button", document.body).find((item) => {
      return item.textContent?.trim() === "Unsubscribe";
    });
    if (!button) {
      throw new Error("The unsubscribe action is unavailable");
    }
    expect(button).toBeEnabled();
    return button;
  });
  click(confirm);
}

test("An invalid email link reports an unsubscribe error after confirmation", async () => {
  context.mocks.api(emailUnsubscribeContract.unsubscribe, ({ respond }) => {
    return respond(400, { error: "Invalid token" });
  });

  await setupPage({
    context,
    auth: null,
    path: "/email/unsubscribe?token=invalid",
  });
  await confirmUnsubscribe();

  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Something went wrong")).toBeInTheDocument();
});

test("An email link without a token offers no unsubscribe action", async () => {
  await setupPage({ context, auth: null, path: "/email/unsubscribe" });

  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Something went wrong")).toBeInTheDocument();
  expect(queryAllByRoleFast("button", document.body)).toHaveLength(0);
});

test("A signed-out recipient can confirm email unsubscribe", async () => {
  context.mocks.api(emailUnsubscribeContract.unsubscribe, ({ respond }) => {
    return respond(200, { unsubscribed: true });
  });

  await setupPage({
    context,
    auth: null,
    path: "/email/unsubscribe?token=valid",
  });
  await confirmUnsubscribe();

  await expect(
    screen.findByRole("heading", { name: "Unsubscribed" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "You will no longer receive system-initiated email notifications from Okou.",
    ),
  ).toBeInTheDocument();
});
