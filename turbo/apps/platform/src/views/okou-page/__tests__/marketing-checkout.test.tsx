import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
  billingUsagePackManagementContract,
} from "@okouai/api-contracts/contracts/billing";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import {
  findButton,
  promptEvent,
  readyChat,
  RUN_PATH,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const ENDPOINT = "https://www.okou.ai/api/events";
const STRIPE_URL = "https://checkout.stripe.com/test/marketing-paywall";
const OCCURRED_AT = "2026-09-17T08:30:00.000Z";

function prepareCheckout() {
  context.mocks.data.org({
    id: "org_marketing_checkout",
    name: "Checkout Workspace",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      showUsagePack: false,
      tier: "limited-free-1",
      ...billingPlanCapabilities("limited-free-1"),
      canBuyCredits: false,
      credits: 0,
      onboardingPaymentPending: false,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: false,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 0,
      concurrencySubscriptions: [],
    });
  });
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "checkout-prompt",
        runId: "d0000000-0000-4000-a000-000000001401",
        seqId: 1,
        text: "Create a campaign brief",
      }),
      {
        id: "checkout-run-error",
        eventType: "output.error",
        role: "assistant",
        content: null,
        error: "insufficient_credits",
        runId: "d0000000-0000-4000-a000-000000001401",
        seqId: 2,
        createdAt: OCCURRED_AT,
      },
    ],
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 2000,
          totalCredits: 22_000,
        },
      ],
    });
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No usage-pack subscription" },
    });
  });
  context.mocks.api(billingUsagePackCheckoutContract.create, ({ respond }) => {
    return respond(200, { url: STRIPE_URL });
  });
  mockNow(new Date(OCCURRED_AT), context.signal);
}

async function openCheckout() {
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  await expect(
    screen.findByText(/Upgrade to Pro to keep chatting/u),
  ).resolves.toBeInTheDocument();
  click(await findButton("Upgrade to Pro"));
  const plans = await screen.findByRole("dialog", { name: "Choose a plan" });
  click(await within(plans).findByText("Start with Pro"));
  return await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
}

function button(name: string, dialog: HTMLElement) {
  const button = queryAllByRoleFast("button", dialog).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!button) {
    throw new Error(`Expected the ${name} button`);
  }
  return button;
}

test("A confirmed checkout sends a Marketing event without waiting for it", async () => {
  prepareCheckout();
  context.mocks.api(
    billingUsagePackCheckoutContract.create,
    ({ body, respond }) => {
      if (body.previewToken) {
        return respond(200, { url: STRIPE_URL });
      }
      return respond(200, {
        status: "preview",
        purchaseType: "usage_pack",
        tier: "pro",
        immediateAmountCents: 2000,
        nextRecurringAmountCents: 2000,
        currency: "usd",
        expiresAt: "2026-09-17T08:40:00.000Z",
        previewToken: "marketing-upgrade-preview",
      });
    },
  );
  const received = context.mocks.deferred<Request>();
  const complete = context.mocks.deferred<void>();
  context.mocks.http.post(ENDPOINT, async ({ request }) => {
    received.resolve(request);
    await complete.promise;
    return new Response(null, { status: 204 });
  });
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const packages = await openCheckout();

  fireEvent.click(button("Upgrade to Pro", packages), { ctrlKey: true });
  const review = await screen.findByRole("dialog", { name: "Order summary" });
  click(button("Confirm", review));
  const request = await received.promise;
  await waitFor(() => {
    expect(open).toHaveBeenCalledWith(STRIPE_URL, "_blank");
  });

  await expect(request.json()).resolves.toStrictEqual({
    eventId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    ),
    tag: "checkout-start",
  });
  expect(request.credentials).toBe("include");
  expect(request.headers.get("authorization")).toBe("Bearer test-token");
  expect(request.headers.get("content-type")).toBe("application/json");
  expect(request.signal.aborted).toBeFalsy();
  complete.resolve();
});

test("A Marketing failure does not prevent the Stripe redirect or start retries", async () => {
  prepareCheckout();
  const received = context.mocks.deferred<void>();
  let requests = 0;
  context.mocks.http.post(ENDPOINT, () => {
    requests++;
    received.resolve();
    return Response.error();
  });
  const packages = await openCheckout();
  click(button("Upgrade to Pro", packages));
  await received.promise;
  await waitFor(() => {
    expect(window.location.href).toBe(STRIPE_URL);
  });
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("focus"));
  expect(requests).toBe(1);
});

test("An expired upgrade preview keeps the quoted amount visible with the confirmation error", async () => {
  prepareCheckout();
  context.mocks.api(
    billingUsagePackCheckoutContract.create,
    ({ body, respond }) => {
      if (body.previewToken !== undefined) {
        return respond(409, {
          error: { code: "CONFLICT", message: "Preview expired" },
        });
      }
      return respond(200, {
        status: "preview",
        purchaseType: "usage_pack",
        tier: "pro",
        immediateAmountCents: 2000,
        nextRecurringAmountCents: 2000,
        currency: "usd",
        expiresAt: "2026-09-17T08:40:00.000Z",
        previewToken: "preview-plan",
      });
    },
  );
  const packages = await openCheckout();
  click(button("Upgrade to Pro", packages));
  const dialog = await screen.findByRole("dialog", { name: "Order summary" });
  click(button("Confirm", dialog));
  await within(dialog).findByText(/Could not prepare the subscription change/u);
  expect(within(dialog).getAllByText("$20.00")).toHaveLength(2);
  expect(button("Confirm", dialog)).toBeEnabled();
});
