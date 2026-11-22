import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  billingStatus,
  installQueuePageFixture,
  queueResponse,
} from "../../queue-page/__tests__/queue-page-test-helpers.ts";

const context = testContext();
test("realtime-004 The open queue applies its organization's update without subscribing to another member's queue", async () => {
  const edition = (running: number) => {
    return queueResponse({
      tier: "team",
      limit: 10,
      active: running,
      available: 10 - running,
      memberUsage: [],
    });
  };
  const queue = installQueuePageFixture(context, {
    billing: billingStatus({}),
    queue: edition(2),
  });
  await setupPage({
    context,
    path: "/?queue=1",
    sharedWorkerTestTransport: "message-port",
  });
  const panel = within(await screen.findByRole("dialog"));
  await expect(
    panel.findByText(/2.*of.*10|2\s*\/\s*10/u),
  ).resolves.toBeVisible();
  const live = context.mocks.ably;
  await waitFor(() => {
    return expect(
      live.hasSubscriptionOnChannel("org:org_default", "runQueueChanged"),
    ).toBeTruthy();
  });
  expect(
    live.hasSubscriptionOnChannel("user:test-user-123", "runQueueChanged"),
  ).toBeFalsy();
  queue.setQueueResponse(edition(6));
  live.triggerOnChannel("user:test-user-123", "runQueueChanged", {});
  expect(panel.queryByText(/6.*of.*10|6\s*\/\s*10/u)).toBeNull();
  live.triggerOnChannel("org:org_default", "runQueueChanged", {});
  await expect(
    panel.findByText(/6.*of.*10|6\s*\/\s*10/u),
  ).resolves.toBeVisible();
  expect(panel.queryAllByText(/6.*of.*10|6\s*\/\s*10/u)).toHaveLength(1);
});
