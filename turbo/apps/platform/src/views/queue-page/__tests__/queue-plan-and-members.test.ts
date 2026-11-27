import type { ConcurrencyInfo } from "@okouai/api-contracts/contracts/runs";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import {
  installQueuePageFixture,
  billingStatus,
  queueResponse,
} from "./queue-page-test-helpers.ts";
import { findFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";

const context = testContext();
function plan(
  tier: ConcurrencyInfo["tier"],
  limit: number,
  active = limit,
  memberUsage: ConcurrencyInfo["memberUsage"] = [],
): ConcurrencyInfo {
  return { tier, limit, active, available: limit - active, memberUsage };
}
function bill(queue: ConcurrencyInfo) {
  return billingStatus({
    tier: queue.tier,
    ...billingPlanCapabilities(queue.tier),
    concurrencyLimit: queue.limit,
  });
}
async function open(
  queue: ConcurrencyInfo,
  role: "member" | "admin" = "member",
) {
  const api = installQueuePageFixture(context, {
    role,
    billing: {
      ...bill(queue),
      ...(role === "member" ? { canBuyConcurrency: false } : {}),
    },
    queue: queueResponse(queue),
  });
  await setupPage({
    context,
    path: "/?queue=1",
  });
  const drawer = await screen.findByRole("dialog", {
    name: "Your request is queued",
  });
  await within(drawer).findByText((text) => {
    return [
      queue.active + " of " + queue.limit + " slot in use",
      queue.active + " of " + queue.limit + " slots in use",
    ].some((label) => {
      return text.includes(label);
    });
  });
  return { drawer, api };
}
test("queue-001 Closing the full Team queue dismisses its deep-linked drawer", async () => {
  const { drawer } = await open(plan("team", 10));
  click(await findFastControl("button", "Close", drawer));
  await waitFor(() => {
    return expect(drawer).not.toBeInTheDocument();
  });
});
test("queue-003 A Team member sees exhausted capacity without purchase actions", async () => {
  const q = plan("team", 10);
  const { drawer } = await open(q);
  const view = within(drawer);
  expect(view.getByText("Team")).toBeInTheDocument();
  expect(view.getByText("0 slots")).toBeInTheDocument();
  expect(view.queryByText("Additional concurrency")).toBeNull();
  expect(view.queryByText(/^Upgrade to /)).toBeNull();
  expect(view.queryByText(/^Buy\b/)).toBeNull();
});
test("queue-004 A limited-free member sees the Free plan in their queue", async () => {
  const { drawer } = await open(plan("limited-free-1", 2, 1));
  expect(within(drawer).getByText("Free")).toBeInTheDocument();
});
test("queue-007 Named members account for the active slots in the Team drawer", async () => {
  const usage = [
    { displayName: "Bingjie Zang", active: 7 },
    { displayName: "You Liang", active: 5 },
    { displayName: "Ethan Zhang", active: 3 },
    { displayName: "Linghan Hu", active: 2 },
  ];
  const { drawer } = await open(
    plan(
      "team",
      80,
      17,
      usage.map((member) => {
        return { ...member, userId: crypto.randomUUID() };
      }),
    ),
  );
  const view = within(drawer);
  for (const member of usage) {
    const row = view.getByText(member.displayName).closest("li")!;
    expect(within(row).getByText(member.active + " slots")).toBeInTheDocument();
  }
  expect(view.getByText("63 slots")).toBeInTheDocument();
});
test("queue-009 A full workspace offers Pro then Team as the billing tier changes", async () => {
  const { drawer, api } = await open(plan("limited-free-1", 2), "admin");
  await expect(
    findFastControl("button", "Upgrade to Pro", drawer),
  ).resolves.toBeEnabled();
  const pro = plan("pro", 3);
  api.setQueueResponse(queueResponse(pro));
  api.setBillingStatus(bill(pro));
  triggerAblyEvent("billing:changed");
  triggerAblyEvent("runQueueChanged");
  const view = within(drawer);
  await view.findByText("3 of 3 slots in use");
  expect(view.getByText("Pro")).toBeInTheDocument();
  await expect(
    findFastControl("button", "Upgrade to Team", drawer),
  ).resolves.toBeEnabled();
});

test("The queue drawer receives the active organization's capacity update on its workspace channel", async () => {
  const { drawer, api } = await open(plan("team", 7, 6));
  const organization = "org:org_default";
  const topic = "runQueueChanged";
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(organization, topic),
    ).toBeTruthy();
  });
  expect(
    context.mocks.ably.hasSubscriptionOnChannel("user:test-user-123", topic),
  ).toBeFalsy();
  api.setQueueResponse(queueResponse(plan("team", 7, 4)));
  context.mocks.ably.triggerOnChannel("user:test-user-123", topic);
  const view = within(drawer);
  expect(view.getByText("6 of 7 slots in use")).toBeVisible();
  context.mocks.ably.triggerOnChannel(organization, topic);
  await expect(view.findByText("4 of 7 slots in use")).resolves.toBeVisible();
  expect(view.getByText("3 slots")).toBeVisible();
});
