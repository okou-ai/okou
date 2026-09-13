import {
  billingCheckoutContract,
  billingCreditCheckoutContract,
  billingStatusContract,
  type BillingStatusResponse,
  type CreditCheckoutRequest,
} from "@okouai/api-contracts/contracts/billing";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  context,
  findButton,
  installRunChat,
  promptEvent,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

const BILLING_RUN_ID = "d0000000-0000-4000-a000-000000001301";

type WorkspaceRole = "admin" | "member";

function billingFailure(error: "insufficient_credits" | "pro_required") {
  return [
    promptEvent({
      id: "billing-user-prompt",
      runId: BILLING_RUN_ID,
      seqId: 1,
      text: "Finish the campaign brief",
    }),
    {
      id: "billing-run-error",
      eventType: "output.error",
      role: "assistant",
      content: null,
      error,
      runId: BILLING_RUN_ID,
      seqId: 2,
      createdAt: "2026-08-01T10:00:02.000Z",
    },
  ] satisfies MockChatEventInput[];
}

function billingStatus(args: {
  readonly tier: string;
  readonly credits: number;
  readonly canBuyCredits: boolean;
}): BillingStatusResponse {
  const paid = args.tier === "pro" || args.tier === "team";
  return {
    showUsagePack: false,
    tier: args.tier,
    ...billingPlanCapabilities(args.tier),
    canBuyCredits: args.canBuyCredits,
    credits: args.credits,
    onboardingPaymentPending: false,
    subscriptionStatus: paid ? "active" : null,
    currentPeriodEnd: paid ? "2026-09-30T00:00:00.000Z" : null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: paid,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

function installBillingState(args: {
  readonly tier: string;
  readonly role: WorkspaceRole;
  readonly credits: number;
  readonly canBuyCredits: boolean;
}): void {
  context.mocks.data.org({
    id: "org_billing_recovery",
    name: "Billing Recovery Workspace",
    role: args.role,
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus(args));
  });
}

function installBlockedChat(
  error: "insufficient_credits" | "pro_required" = "insufficient_credits",
): void {
  installRunChat({ chatEvents: billingFailure(error) });
}

function queryButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((button) => {
      return (
        button.getAttribute("aria-label") === name ||
        button.textContent?.replace(/\s+/gu, " ").trim() === name
      );
    }) ?? null
  );
}

function button(name: string, container: ParentNode = document.body) {
  const match = queryButton(name, container);
  if (!match) {
    throw new Error(`${name} button was not visible`);
  }
  return match;
}

async function expectProCheckout(): Promise<void> {
  const user = userEvent.setup({ delay: null });
  const checkoutRequests: string[] = [];
  context.mocks.api(billingCheckoutContract.create, ({ body, respond }) => {
    checkoutRequests.push(body.tier);
    return respond(200, { url: "https://checkout.example.test/pro" });
  });

  await user.click(await findButton("Upgrade to Pro"));

  await waitFor(() => {
    expect(checkoutRequests).toStrictEqual(["pro"]);
    expect(window.location.href).toBe("https://checkout.example.test/pro");
  });
}

test("Direct a workspace member to an admin when billing blocks a run", async () => {
  installBillingState({
    tier: "free",
    ...billingPlanCapabilities("free"),
    role: "member",
    credits: 0,
    canBuyCredits: false,
  });
  installBlockedChat();

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText(/Ask a workspace admin to upgrade to Pro/u),
  ).resolves.toBeVisible();
  expect(queryButton("Upgrade to Pro")).not.toBeInTheDocument();
  expect(queryButton("$100")).not.toBeInTheDocument();
  expect(queryButton("Custom")).not.toBeInTheDocument();
});

test("Let a workspace admin recover from a free-plan billing limit", async () => {
  installBillingState({
    tier: "free",
    ...billingPlanCapabilities("free"),
    role: "admin",
    credits: 0,
    canBuyCredits: false,
  });
  installBlockedChat("insufficient_credits");

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText(/Upgrade to Pro to keep chatting/u),
  ).resolves.toBeVisible();

  await expectProCheckout();
});

test("Let a limited-free workspace admin unlock a Pro-only video capability", async () => {
  installBillingState({
    tier: "limited-free-1",
    ...billingPlanCapabilities("limited-free-1"),
    role: "admin",
    credits: 500,
    canBuyCredits: false,
  });
  installBlockedChat("pro_required");

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText(/Upgrade to Pro to keep chatting/u),
  ).resolves.toBeVisible();

  await expectProCheckout();
});

test("Let a paid workspace admin buy more credits", async () => {
  const user = userEvent.setup({ delay: null });
  const checkoutRequests: CreditCheckoutRequest[] = [];
  installBillingState({
    tier: "pro",
    ...billingPlanCapabilities("pro"),
    role: "admin",
    credits: 0,
    canBuyCredits: true,
  });
  context.mocks.api(
    billingCreditCheckoutContract.create,
    ({ body, respond }) => {
      checkoutRequests.push(body);
      return respond(200, {
        status: "preview",
        credits: body.credits,
        amountCents: body.credits / 10,
        currency: "usd",
        expiresAt: "2026-09-01T00:10:00.000Z",
        previewToken: `credit-preview-${String(checkoutRequests.length)}`,
      });
    },
  );
  installBlockedChat();

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText("You're out of credits"),
  ).resolves.toBeVisible();
  for (const amount of ["$100", "$200", "$300"]) {
    expect(button(amount)).toBeVisible();
  }

  click(button("$100"));

  let review = await screen.findByRole("dialog", {
    name: "Review credit purchase",
  });
  expect(within(review).getByText("$100.00")).toBeVisible();
  expect(checkoutRequests[0]).toMatchObject({
    credits: 100_000,
    supportsInAppPreview: true,
  });
  click(button("Cancel", review));

  click(button("Custom"));
  const customAmount = screen.getByRole("textbox", {
    name: "Custom dollar amount",
  });
  await fill(customAmount, "250");
  click(button("Buy"));

  review = await screen.findByRole("dialog", {
    name: "Review credit purchase",
  });
  expect(within(review).getByText("$250.00")).toBeVisible();
  expect(checkoutRequests[1]).toMatchObject({
    credits: 250_000,
    customAmount: true,
    supportsInAppPreview: true,
  });
  click(button("Cancel", review));

  await fill(customAmount, "0");
  click(button("Buy"));
  await expect(
    screen.findAllByText("Enter between $1 and $10,000"),
  ).resolves.not.toHaveLength(0);
  expect(checkoutRequests).toHaveLength(2);

  await fill(customAmount, "10001");
  await user.click(button("Buy"));
  expect(screen.getAllByText("Enter between $1 and $10,000")).not.toHaveLength(
    0,
  );
  expect(checkoutRequests).toHaveLength(2);
});

test("Offer a plan upgrade when a paid workspace cannot buy top-ups", async () => {
  installBillingState({
    tier: "pro-suspend",
    ...billingPlanCapabilities("pro-suspend"),
    role: "admin",
    credits: 0,
    canBuyCredits: false,
  });
  installBlockedChat();

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText(/Upgrade to Pro to keep chatting/u),
  ).resolves.toBeVisible();
  await expect(findButton("Upgrade to Pro")).resolves.toBeVisible();
  expect(queryButton("$100")).not.toBeInTheDocument();
  expect(queryButton("Custom")).not.toBeInTheDocument();
});

test("Show that a previously blocked chat can continue after credits return", async () => {
  installBillingState({
    tier: "pro",
    ...billingPlanCapabilities("pro"),
    role: "member",
    credits: 25_000,
    canBuyCredits: true,
  });
  installBlockedChat();

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(screen.findByText("Credits available")).resolves.toBeVisible();
  expect(
    screen.getByText(
      /Your credits have been added\. You can continue chatting/u,
    ),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  expect(queryButton("Upgrade to Pro")).not.toBeInTheDocument();
  expect(queryButton("$100")).not.toBeInTheDocument();
});
