import { emailUnsubscribeContract } from "@okouai/api-contracts/contracts/email-unsubscribe";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function getButton(name: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

test("An invalid unsubscribe token shows an error", async () => {
  context.mocks.api(emailUnsubscribeContract.unsubscribe, ({ respond }) => {
    return respond(400, { error: "Invalid unsubscribe token" });
  });

  await setupPage({
    context,
    path: "/email/unsubscribe?token=invalid-token",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", {
      name: "Unsubscribe from email notifications?",
    }),
  ).resolves.toBeVisible();
  click(getButton("Unsubscribe"));

  await expect(
    screen.findByRole("heading", { name: "Something went wrong" }),
  ).resolves.toBeVisible();
});

test("A user can confirm email unsubscribe", async () => {
  context.mocks.api(emailUnsubscribeContract.unsubscribe, ({ respond }) => {
    return respond(200, { unsubscribed: true });
  });

  await setupPage({
    context,
    path: "/email/unsubscribe?token=valid-token",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", {
      name: "Unsubscribe from email notifications?",
    }),
  ).resolves.toBeVisible();
  expect(getButton("Unsubscribe")).toBeEnabled();
  click(getButton("Unsubscribe"));

  await expect(
    screen.findByRole("heading", { name: "Unsubscribed" }),
  ).resolves.toBeVisible();
  expect(
    screen.getByText(
      "You will no longer receive system-initiated email notifications from Okou.",
    ),
  ).toBeVisible();
});
