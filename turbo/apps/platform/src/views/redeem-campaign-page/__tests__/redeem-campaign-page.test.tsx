import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("A billing outage shows a temporary redemption error", async () => {
  context.mocks.data.redeemResponse({
    status: "error",
    reason: "billing_unavailable",
  });

  await setupPage({
    context,
    path: "/redeem/summer-credits",
    host: "app.okou.ai",
  });

  await expect(
    screen.findByText("Billing is temporarily unavailable"),
  ).resolves.toBeVisible();
  expect(
    screen.getByText("Our payment system isn't available right now."),
  ).toBeVisible();
  expect(
    queryAllByRoleFast("link").find((candidate) => {
      return candidate.textContent?.trim() === "Redeem credits";
    }),
  ).toBeUndefined();
});

test("A non-admin cannot redeem workspace campaign credits", async () => {
  context.mocks.data.redeemResponse({
    status: "error",
    reason: "admin_required",
  });

  await setupPage({
    context,
    path: "/redeem/summer-credits",
    host: "app.okou.ai",
  });

  await expect(
    screen.findByText("Admin access required"),
  ).resolves.toBeVisible();
  expect(
    screen.getByText(
      "Only organization admins can redeem campaign credits for Default Org. Ask an admin in your org to open the link instead.",
    ),
  ).toBeVisible();
  expect(
    queryAllByRoleFast("link").find((candidate) => {
      return candidate.textContent?.trim() === "Redeem credits";
    }),
  ).toBeUndefined();
});

test("A processing redemption confirms payment", async () => {
  context.mocks.data.redeemResponse({ status: "processing" });

  await setupPage({
    context,
    path: "/redeem/summer-credits",
    host: "app.okou.ai",
  });

  await expect(screen.findByText("Payment received")).resolves.toBeVisible();
  expect(
    screen.getByText(
      "We're applying your credits to Default Org now. This usually takes a few seconds.",
    ),
  ).toBeVisible();
});
