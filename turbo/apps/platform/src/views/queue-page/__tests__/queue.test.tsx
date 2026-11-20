import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { billingCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
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

test("The queue deep link opens a drawer that can be closed", async () => {
  const user = userEvent.setup({ delay: null });
  installQueuePageFixture(context, {
    billing: billingStatus({}),
    queue: queueResponse({
      tier: "team",
      limit: 10,
      active: 10,
      available: 0,
      memberUsage: [],
    }),
  });

  await setupPage({ context, path: openQueuePath() });

  const drawer = await visibleQueueDrawer();
  await user.click(button(drawer, "Close"));
  await waitFor(() => {
    expect(drawer).not.toBeInTheDocument();
  });
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

test("The queue labels the limited-free tier as Free", async () => {
  installQueuePageFixture(context, {
    billing: billingStatus({
      tier: "limited-free-1",
      ...billingPlanCapabilities("limited-free-1"),
      concurrencyLimit: 1,
    }),
    queue: queueResponse({
      tier: "limited-free-1",
      limit: 1,
      active: 1,
      available: 0,
      memberUsage: [],
    }),
    role: "member",
  });

  await setupPage({ context, path: openQueuePath() });

  const drawer = await visibleQueueDrawer();
  expect(within(drawer).getByText("Free")).toBeInTheDocument();
});

test("The queue shows active slot usage for each member", async () => {
  installQueuePageFixture(context, {
    billing: billingStatus({ tier: "team", concurrencyLimit: 80 }),
    queue: queueResponse({
      tier: "team",
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
    billing: billingStatus({ tier: "limited-free-1", concurrencyLimit: 2 }),
    queue: queueResponse({
      tier: "limited-free-1",
      limit: 2,
      active: 2,
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
  expect(within(drawer).getByText("2 of 2 slots in use")).toBeVisible();
  expect(within(drawer).getByText("Available now")).toBeVisible();
  expect(within(drawer).getByText("0 slots")).toBeVisible();
  expect(button(drawer, "Upgrade to Pro")).toBeEnabled();

  fixture.setQueueResponse(
    queueResponse({
      tier: "pro",
      limit: 3,
      active: 3,
      available: 0,
      memberUsage: [],
    }),
  );
  fixture.setBillingStatus(billingStatus({ tier: "pro", concurrencyLimit: 3 }));
  await announceBillingChange();

  const proPlan = await within(drawer).findByText("Pro");
  expect(proPlan).toBeVisible();
  expect(button(drawer, "Upgrade to Team")).toBeEnabled();
});
