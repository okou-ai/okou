import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/campaign-session";

function getLink(name: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Link not found: ${name}`);
  }
  return link;
}

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

test("A ready credit campaign links to checkout", async () => {
  context.mocks.data.redeemResponse({
    status: "ready",
    checkoutUrl: CHECKOUT_URL,
  });

  await setupPage({
    context,
    path: "/redeem/summer-credits",
    host: "app.okou.ai",
  });

  await expect(screen.findByText("Claim your credits")).resolves.toBeVisible();
  expect(
    screen.getByText(
      "Complete checkout to add these credits to Default Org's balance.",
    ),
  ).toBeVisible();
  expect(getLink("Redeem credits")).toHaveAttribute("href", CHECKOUT_URL);
});

test("A Stripe success return confirms credits immediately", async () => {
  await setupPage({
    context,
    path: "/redeem/summer-credits?stripe=success",
    host: "app.okou.ai",
  });

  await expect(screen.findByText("Payment successful")).resolves.toBeVisible();
  expect(
    screen.getByText(
      "Your credits are on the way to Default Org. Open the dashboard to see your new balance.",
    ),
  ).toBeVisible();
});
