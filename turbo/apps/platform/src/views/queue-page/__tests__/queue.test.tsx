import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  billingCheckoutContract,
  billingConcurrencyCheckoutContract,
  billingConcurrencySubscriptionContract,
} from "@okouai/api-contracts/contracts/billing";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  billingStatus,
  installQueuePageFixture,
  QUEUE_AGENT_ID,
  queueResponse,
} from "./queue-page-test-helpers.ts";

const context = testContext();

function openQueuePath(): string {
  return `/agents/${QUEUE_AGENT_ID}/chat?queue=1`;
}

async function visibleQueueDrawer(): Promise<HTMLElement> {
  return await screen.findByRole("dialog", {
    name: "Your agent is waiting in line",
  });
}

async function announceBillingChange(): Promise<void> {
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });
  act(() => {
    context.mocks.ably.trigger("billing:changed");
  });
}

/**
 * Drop the realtime connection long enough that Ably discards channel state,
 * then restore it. The reattach reports no continuity, which is the only signal
 * a tab gets that it may have missed events while it was away.
 */
async function surviveConnectionGap(): Promise<void> {
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });
  act(() => {
    context.mocks.ably.triggerSharedWorkerConnectionState("suspended", {
      code: 80_003,
      message: "Unable to connect (network unreachable)",
    });
    context.mocks.ably.triggerSharedWorkerConnectionState("connected");
  });
}

function buttonLabel(button: HTMLElement): string {
  return (
    button.getAttribute("aria-label") ??
    button.textContent?.replace(/\s+/gu, " ").trim() ??
    ""
  );
}

function queryButton(
  container: ParentNode,
  name: string | RegExp,
): HTMLElement | undefined {
  return queryAllByRoleFast("button", container).find((button) => {
    const label = buttonLabel(button);
    return typeof name === "string" ? label === name : name.test(label);
  });
}

function button(container: ParentNode, name: string): HTMLElement {
  const result = queryButton(container, name);
  expect(result).toBeDefined();
  return result!;
}

test("Team and Custom administrators can buy additional concurrency without changing plans", async () => {
  const teamBilling = billingStatus({
    tier: "team",
    canBuyConcurrency: true,
    concurrencyLimit: 5,
    concurrencyUnitAmountCents: 4200,
  });
  const fixture = installQueuePageFixture(context, {
    billing: teamBilling,
    queue: queueResponse({
      tier: "team",
      limit: 5,
      active: 3,
      available: 2,
      memberUsage: [],
    }),
  });

  await setupPage({ context, path: openQueuePath() });

  const drawer = await visibleQueueDrawer();
  expect(within(drawer).getByText("Team")).toBeVisible();
  expect(within(drawer).getByText("3 of 5 slots in use")).toBeVisible();
  expect(within(drawer).getByText("Additional concurrency")).toBeVisible();
  expect(button(drawer, "Buy $42/month")).toBeEnabled();
  expect(queryButton(drawer, /^Upgrade to /u)).toBeUndefined();

  fixture.setQueueResponse(
    queueResponse({
      tier: "custom",
      limit: 10,
      active: 10,
      available: 0,
      memberUsage: [],
    }),
  );
  fixture.setBillingStatus(
    billingStatus({
      tier: "custom",
      canBuyConcurrency: true,
      concurrencyLimit: 10,
      concurrencyUnitAmountCents: 10_000,
    }),
  );
  await announceBillingChange();

  const customPlan = await within(drawer).findByText("Custom");
  expect(customPlan).toBeVisible();
  expect(within(drawer).getByText("10 of 10 slots in use")).toBeVisible();
  expect(button(drawer, "Buy $100/month")).toBeEnabled();
  expect(queryButton(drawer, /^Upgrade to /u)).toBeUndefined();
});

test("Queue billing actions appear only for authorized administrators and supported plans", async () => {
  installQueuePageFixture(context, {
    billing: billingStatus({
      tier: "team",
      canBuyConcurrency: false,
      concurrencyLimit: 10,
      concurrencyUnitAmountCents: 10_000,
    }),
    queue: queueResponse({
      tier: "team",
      limit: 10,
      active: 10,
      available: 0,
      memberUsage: [],
    }),
    role: "member",
  });

  await setupPage({ context, path: openQueuePath() });

  const drawer = await visibleQueueDrawer();
  expect(within(drawer).getByText("Team")).toBeVisible();
  expect(within(drawer).getByText("10 of 10 slots in use")).toBeVisible();
  expect(within(drawer).getByText("Available now")).toBeVisible();
  expect(within(drawer).getByText("0 slots")).toBeVisible();
  expect(within(drawer).queryByText("Additional concurrency")).toBeNull();
  expect(queryButton(drawer, /^Buy /u)).toBeUndefined();
  expect(queryButton(drawer, /^Upgrade to /u)).toBeUndefined();
});

test("A Team administrator reviews and pays for an existing concurrency change", async () => {
  const previewRequests: number[] = [];
  const confirmRequests: number[] = [];
  installQueuePageFixture(context, {
    billing: billingStatus({
      tier: "team",
      canBuyConcurrency: true,
      concurrencyLimit: 10,
      concurrencyUnitAmountCents: 10_000,
      concurrencySubscriptions: [
        {
          id: "concurrency-subscription-1",
          quantity: 2,
          currentPeriodEnd: "2026-10-01T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          canReduce: true,
          canChangeInApp: true,
        },
      ],
    }),
    queue: queueResponse({
      tier: "team",
      limit: 10,
      active: 10,
      available: 0,
      memberUsage: [],
    }),
  });
  context.mocks.api(
    billingConcurrencySubscriptionContract.previewChange,
    ({ body, respond }) => {
      previewRequests.push(body.quantity);
      return respond(200, {
        currentQuantity: 2,
        targetQuantity: body.quantity,
        immediateAmountCents: 4321,
        nextRecurringAmountCents: 40_000,
        currency: "usd",
        paymentMethodPreviewToken: "change-preview-token",
      });
    },
  );
  context.mocks.api(
    billingConcurrencySubscriptionContract.confirmChange,
    ({ body, respond }) => {
      confirmRequests.push(body.quantity);
      return respond(200, {
        status: "pending_payment",
        hostedInvoiceUrl: "https://invoice.stripe.test/concurrency-change",
      });
    },
  );

  await setupPage({ context, path: openQueuePath() });

  const drawer = await visibleQueueDrawer();
  expect(within(drawer).getByText("Additional concurrency")).toBeVisible();
  expect(
    within(drawer).getByText(
      "Review the amount due now and your updated monthly subscription.",
    ),
  ).toBeVisible();
  await userEvent.click(button(drawer, "Increase concurrency quantity"));
  await userEvent.click(button(drawer, "Buy $200/month"));

  const review = await screen.findByRole("dialog", {
    name: "Review concurrency change",
  });
  expect(within(review).getByText("4")).toBeVisible();
  expect(within(review).getByText("$43.21")).toBeVisible();
  expect(within(review).getByText("$400.00/month")).toBeVisible();
  expect(previewRequests).toStrictEqual([4]);
  expect(
    screen.queryByRole("dialog", { name: "Review concurrency purchase" }),
  ).not.toBeInTheDocument();

  await userEvent.click(button(review, "Pay and update"));

  await waitFor(() => {
    expect(confirmRequests).toStrictEqual([4]);
    expect(window.location.href).toBe(
      "https://invoice.stripe.test/concurrency-change",
    );
  });
});

test("A Team administrator reviews a first concurrency purchase before checkout", async () => {
  const previewRequests: number[] = [];
  const checkoutRequests: {
    readonly quantity: number;
    readonly successUrl: string;
  }[] = [];
  installQueuePageFixture(context, {
    billing: billingStatus({
      tier: "team",
      canBuyConcurrency: true,
      concurrencyLimit: 10,
      concurrencyUnitAmountCents: 10_000,
      concurrencyPurchaseReviewAvailable: true,
      concurrencySubscriptions: [],
    }),
    queue: queueResponse({
      tier: "team",
      limit: 10,
      active: 10,
      available: 0,
      memberUsage: [],
    }),
  });
  context.mocks.api(
    billingConcurrencyCheckoutContract.preview,
    ({ body, respond }) => {
      previewRequests.push(body.quantity);
      return respond(200, {
        currentQuantity: 0,
        targetQuantity: body.quantity,
        immediateAmountCents: 7000,
        nextRecurringAmountCents: 22_000,
        currency: "usd",
        paymentMethodPreviewToken: "purchase-preview-token",
      });
    },
  );
  context.mocks.api(
    billingConcurrencyCheckoutContract.create,
    ({ body, respond }) => {
      checkoutRequests.push({
        quantity: body.quantity,
        successUrl: body.successUrl,
      });
      return respond(200, { url: body.successUrl });
    },
  );

  await setupPage({ context, path: openQueuePath() });

  const drawer = await visibleQueueDrawer();
  const quantity = within(drawer).getByRole("textbox", { name: "Quantity" });
  await userEvent.click(quantity);
  await userEvent.keyboard("{Control>}a{/Control}{Backspace}");

  expect(within(drawer).getByText("$0/month")).toBeVisible();
  expect(button(drawer, "Buy $0/month")).toBeDisabled();

  await userEvent.type(quantity, "5");
  const buy = button(drawer, "Buy $500/month");
  await userEvent.click(buy);

  const review = await screen.findByRole("dialog", {
    name: "Review concurrency purchase",
  });
  expect(within(review).getByText("5")).toBeVisible();
  expect(within(review).getByText("$70.00")).toBeVisible();
  expect(within(review).getByText("$220.00/month")).toBeVisible();
  expect(previewRequests).toStrictEqual([5]);
  expect(buy).toBeDisabled();

  await userEvent.click(button(review, "Pay and add slots"));

  await waitFor(() => {
    expect(checkoutRequests).toHaveLength(1);
  });
  expect(checkoutRequests[0]?.quantity).toBe(5);
  expect(checkoutRequests[0]?.successUrl).toContain("concurrency=purchased");
  const concurrencyAdded = await screen.findByText(/Concurrency added/u);
  expect(concurrencyAdded).toBeVisible();
});

test("The queue shows active slot usage for each member", async () => {
  installQueuePageFixture(context, {
    billing: billingStatus({ tier: "custom", concurrencyLimit: 80 }),
    queue: queueResponse({
      tier: "custom",
      limit: 80,
      active: 17,
      available: 63,
      memberUsage: [
        { userId: "user-bingjie", displayName: "Bingjie Zang", active: 7 },
        { userId: "user-qiqi", displayName: "You Liang", active: 5 },
        { userId: "user-ethan", displayName: "Ethan Zhang", active: 3 },
        { userId: "user-linghan", displayName: "Linghan Hu", active: 2 },
      ],
    }),
  });

  await setupPage({ context, path: openQueuePath() });

  const drawer = await visibleQueueDrawer();
  expect(within(drawer).getByText("17 of 80 slots in use")).toBeVisible();
  expect(within(drawer).getByText("Bingjie Zang")).toBeVisible();
  expect(within(drawer).getByText("7 slots")).toBeVisible();
  expect(within(drawer).getByText("You Liang")).toBeVisible();
  expect(within(drawer).getByText("5 slots")).toBeVisible();
  expect(within(drawer).getByText("Ethan Zhang")).toBeVisible();
  expect(within(drawer).getByText("3 slots")).toBeVisible();
  expect(within(drawer).getByText("Linghan Hu")).toBeVisible();
  expect(within(drawer).getByText("2 slots")).toBeVisible();
  expect(within(drawer).getByText("Available now")).toBeVisible();
  expect(within(drawer).getByText("63 slots")).toBeVisible();
});

test("A full queue offers the next appropriate plan upgrade", async () => {
  const fixture = installQueuePageFixture(context, {
    billing: billingStatus({ tier: "free", concurrencyLimit: 1 }),
    queue: queueResponse({
      tier: "free",
      limit: 1,
      active: 1,
      available: 0,
      memberUsage: [],
    }),
  });
  context.mocks.api(billingCheckoutContract.create, ({ body, respond }) => {
    return respond(200, {
      url: `https://checkout.stripe.test/plan/${body.tier}`,
    });
  });

  await setupPage({ context, path: openQueuePath() });

  const drawer = await visibleQueueDrawer();
  expect(within(drawer).getByText("Free")).toBeVisible();
  expect(within(drawer).getByText("1 of 1 slot in use")).toBeVisible();
  expect(within(drawer).getByText("Available now")).toBeVisible();
  expect(within(drawer).getByText("0 slots")).toBeVisible();
  expect(button(drawer, "Upgrade to Pro")).toBeEnabled();

  fixture.setQueueResponse(
    queueResponse({
      tier: "pro",
      limit: 2,
      active: 2,
      available: 0,
      memberUsage: [],
    }),
  );
  fixture.setBillingStatus(billingStatus({ tier: "pro", concurrencyLimit: 2 }));
  await announceBillingChange();

  const proPlan = await within(drawer).findByText("Pro");
  expect(proPlan).toBeVisible();
  expect(button(drawer, "Upgrade to Team")).toBeEnabled();
});

test("The open queue reflects billing capacity changes in real time", async () => {
  const fixture = installQueuePageFixture(context, {
    billing: billingStatus({
      tier: "team",
      canBuyConcurrency: true,
      concurrencyLimit: 5,
      concurrencyUnitAmountCents: 10_000,
    }),
    queue: queueResponse({
      tier: "team",
      limit: 5,
      active: 3,
      available: 2,
      memberUsage: [],
    }),
  });

  await setupPage({ context, path: openQueuePath() });

  const drawer = await visibleQueueDrawer();
  expect(within(drawer).getByText("3 of 5 slots in use")).toBeVisible();

  fixture.setQueueResponse(
    queueResponse({
      tier: "team",
      limit: 6,
      active: 3,
      available: 3,
      memberUsage: [],
    }),
  );
  fixture.setBillingStatus(
    billingStatus({
      tier: "team",
      canBuyConcurrency: true,
      concurrencyLimit: 6,
      concurrencyUnitAmountCents: 10_000,
    }),
  );
  await announceBillingChange();

  const increasedCapacity = await within(drawer).findByText(
    "3 of 6 slots in use",
  );
  expect(increasedCapacity).toBeVisible();
  expect(within(drawer).getByText("Available now")).toBeVisible();
  expect(within(drawer).getByText("3 slots")).toBeVisible();
  expect(
    screen.getByRole("dialog", { name: "Your agent is waiting in line" }),
  ).toBe(drawer);
});

test("Queue plan details recover after a realtime connection gap", async () => {
  // A reattach Ably could not replay leaves the tab holding whatever it read
  // before the outage, and no event arrives to correct it. Only the connection
  // itself can produce that state, so the case is driven through the page with
  // the transport interrupted rather than through a published event.
  const fixture = installQueuePageFixture(context, {
    billing: billingStatus({
      tier: "team",
      canBuyConcurrency: true,
      concurrencyLimit: 5,
      concurrencyUnitAmountCents: 4200,
    }),
    queue: queueResponse({
      tier: "team",
      limit: 5,
      active: 3,
      available: 2,
      memberUsage: [],
    }),
  });

  await setupPage({ context, path: openQueuePath() });

  const drawer = await visibleQueueDrawer();
  expect(within(drawer).getByText("3 of 5 slots in use")).toBeVisible();

  // The plan changes while the connection is unusable, so the `billing:changed`
  // event announcing it can never reach this tab.
  fixture.setQueueResponse(
    queueResponse({
      tier: "custom",
      limit: 10,
      active: 10,
      available: 0,
      memberUsage: [],
    }),
  );
  fixture.setBillingStatus(
    billingStatus({
      tier: "custom",
      canBuyConcurrency: true,
      concurrencyLimit: 10,
      concurrencyUnitAmountCents: 10_000,
    }),
  );
  await surviveConnectionGap();

  await expect(within(drawer).findByText("Custom")).resolves.toBeVisible();
  expect(within(drawer).getByText("10 of 10 slots in use")).toBeVisible();
});
