import {
  billingCheckoutContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { marketingEventRequestSchema } from "@okouai/api-contracts/contracts/marketing-events";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import {
  context,
  findButton,
  installRunChat,
  promptEvent,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

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
      tier: "free",
      ...billingPlanCapabilities("free"),
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
  context.mocks.api(billingCheckoutContract.create, ({ respond }) => {
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
}

function confirmButton(dialog: HTMLElement) {
  const button = queryAllByRoleFast("button", dialog).find((candidate) => {
    return candidate.textContent?.trim() === "Upgrade to Pro";
  });
  if (!button) {
    throw new Error("Expected the upgrade confirmation button");
  }
  return button;
}

test("Each actual checkout action sends a new event without waiting for Marketing", async () => {
  prepareCheckout();
  const requests: Request[] = [];
  const firstReceived = context.mocks.deferred<Request>();
  const secondReceived = context.mocks.deferred<Request>();
  const complete = context.mocks.deferred<void>();
  context.mocks.http.post(ENDPOINT, async ({ request }) => {
    requests.push(request);
    (requests.length === 1 ? firstReceived : secondReceived).resolve(request);
    await complete.promise;
    return new Response(null, { status: 204 });
  });
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await openCheckout();

  fireEvent.click(await findButton("Upgrade to Pro"), { ctrlKey: true });
  const first = await firstReceived.promise;
  await waitFor(() => {
    expect(open).toHaveBeenCalledWith(STRIPE_URL, "_blank");
  });
  const nextCheckout = await findButton("Upgrade to Pro");
  await waitFor(() => {
    expect(nextCheckout).toBeEnabled();
  });
  fireEvent.click(nextCheckout, { ctrlKey: true });
  const second = await secondReceived.promise;
  await waitFor(() => {
    expect(open).toHaveBeenCalledTimes(2);
  });

  const firstBody: unknown = await first.json();
  const secondBody = marketingEventRequestSchema.parse(await second.json());
  expect(firstBody).toStrictEqual({
    eventId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    ),
    tag: "checkout-start",
  });
  expect(secondBody.eventId).not.toBe(
    marketingEventRequestSchema.parse(firstBody).eventId,
  );
  expect(first.credentials).toBe("include");
  expect(first.headers.get("authorization")).toBe("Bearer test-token");
  expect(first.headers.get("content-type")).toBe("application/json");
  expect(first.signal.aborted).toBeFalsy();
  expect(requests).toHaveLength(2);
  complete.resolve();
});

test.each(["http", "unauthorized", "network"])(
  "A Marketing %s failure does not prevent the Stripe redirect or start retries",
  async (failure) => {
    prepareCheckout();
    const received = context.mocks.deferred<void>();
    let requests = 0;
    context.mocks.http.post(ENDPOINT, () => {
      requests++;
      received.resolve();
      return failure === "network"
        ? Response.error()
        : new Response(null, {
            status: failure === "unauthorized" ? 401 : 503,
          });
    });
    await openCheckout();
    click(await findButton("Upgrade to Pro"));
    await received.promise;
    await waitFor(() => {
      expect(window.location.href).toBe(STRIPE_URL);
    });
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    expect(requests).toBe(1);
  },
);

test("A Plan preview does not record Checkout Start; a conflict-refresh redirect does", async () => {
  prepareCheckout();
  let checkoutRequests = 0;
  context.mocks.api(billingCheckoutContract.create, ({ body, respond }) => {
    checkoutRequests++;
    if (body.previewToken !== undefined) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Preview expired" },
      });
    }
    if (checkoutRequests > 1) {
      return respond(200, { url: STRIPE_URL });
    }
    return respond(200, {
      status: "preview",
      purchaseType: "plan",
      tier: "pro",
      immediateAmountCents: 2000,
      nextRecurringAmountCents: 2000,
      currency: "usd",
      expiresAt: "2026-09-17T08:40:00.000Z",
      previewToken: "preview-plan",
    });
  });
  const received = context.mocks.deferred<Request>();
  const requests: Request[] = [];
  context.mocks.http.post(ENDPOINT, ({ request }) => {
    requests.push(request);
    received.resolve(request);
    return new Response(null, { status: 204 });
  });
  await openCheckout();
  click(await findButton("Upgrade to Pro"));
  const dialog = await screen.findByRole("dialog", { name: "Upgrade to Pro" });
  expect(requests).toHaveLength(0);
  expect(window.location.href).not.toBe(STRIPE_URL);
  click(confirmButton(dialog));
  const request = await received.promise;
  await waitFor(() => {
    expect(window.location.href).toBe(STRIPE_URL);
  });
  expect(marketingEventRequestSchema.parse(await request.json())).toMatchObject(
    {
      tag: "checkout-start",
    },
  );
  expect(requests).toHaveLength(1);
});
