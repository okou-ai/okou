import { cronMonitorChatEventQueueContract } from "@okouai/api-contracts/contracts/cron";
import {
  testCronMonitorChatEventQueueStateContract,
  type TestCronMonitorChatEventQueueStateActionBody,
  type TestCronMonitorChatEventQueueStateActionResponse,
} from "@okouai/api-contracts/contracts/test-cron-monitor-chat-event-queue-state";
import { beforeEach, describe, expect, it } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { testCronMonitorChatEventQueueStateRoutes } from "../test-cron-monitor-chat-event-queue-state";
import { createFixtureTracker } from "./helpers/route-test";
import { cronMonitorChatEventQueueRoutes } from "../cron-monitor-chat-event-queue";

const context = testContext();
const CRON_SECRET = "test-cron-secret";

interface MonitorFixture {
  readonly composeId: string;
  readonly eventId: string;
  readonly eventIds: readonly string[];
}

function apiClient() {
  return setupApp({ context, routes: cronMonitorChatEventQueueRoutes })(
    cronMonitorChatEventQueueContract,
  );
}

function stateClient() {
  return setupAppWithRoutes({
    context,
    routes: testCronMonitorChatEventQueueStateRoutes,
  })(testCronMonitorChatEventQueueStateContract);
}

async function postState(
  body: TestCronMonitorChatEventQueueStateActionBody,
): Promise<TestCronMonitorChatEventQueueStateActionResponse> {
  const response = await accept(stateClient().action({ body }), [200]);
  return response.body;
}

async function seedFixture(
  fixtureKind: Extract<
    TestCronMonitorChatEventQueueStateActionBody,
    { readonly action: "seed-fixture" }
  >["fixture_kind"],
): Promise<MonitorFixture> {
  const response = await postState({
    action: "seed-fixture",
    fixture_kind: fixtureKind,
  });
  if (!response.compose_id || !response.event_id) {
    throw new Error("orphan monitor seed response is missing fixture IDs");
  }
  if (
    !Array.isArray(response.event_ids) ||
    !response.event_ids.every((eventId) => {
      return typeof eventId === "string";
    })
  ) {
    throw new Error("orphan monitor seed response is missing event IDs");
  }
  return {
    composeId: response.compose_id,
    eventId: response.event_id,
    eventIds: response.event_ids,
  };
}

async function cleanupFixture(fixture: MonitorFixture): Promise<void> {
  await postState({
    action: "delete-fixture",
    compose_id: fixture.composeId,
  });
}

const trackFixture = createFixtureTracker(cleanupFixture);

describe("cron monitor chat event queue", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  it("requires the cron secret", async () => {
    const response = await accept(apiClient().monitor({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("reports zero for legitimate unassociated user messages", async () => {
    const fixtures = await Promise.all([
      trackFixture(seedFixture("active-run")),
      trackFixture(seedFixture("failed-message")),
      trackFixture(seedFixture("queued-integration")),
      trackFixture(seedFixture("queued-message")),
      trackFixture(seedFixture("revoked-message")),
    ]);

    const response = await accept(
      stateClient().monitor({
        body: {
          event_ids: fixtures.flatMap((fixture) => {
            return fixture.eventIds;
          }),
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      orphanedMessages: 0,
    });
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not alert for web or agent-run prompts", async () => {
    const fixture = await trackFixture(seedFixture("orphan"));

    const response = await accept(
      stateClient().monitor({
        body: { event_ids: fixture.eventIds.slice(0, 2) },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      orphanedMessages: 0,
    });
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("raises a grouped alert for every source with a missing context row", async () => {
    const fixture = await trackFixture(seedFixture("orphan"));

    const response = await accept(
      stateClient().monitor({ body: { event_ids: fixture.eventIds.slice(2) } }),
      [500],
    );

    expect(response.body).toStrictEqual({
      error: "Internal server error",
    });
    expect(
      context.mocks.sentry.captureException.mock.calls.at(-1)?.[0],
    ).toMatchObject({
      name: "OrphanedQueuedChatEventsError",
      code: "ORPHANED_QUEUED_CHAT_MESSAGES",
      orphanedMessages: 7,
      orphanedMessagesBySource: {
        agentphone: 1,
        automation: 1,
        feishu: 1,
        github: 1,
        slack: 1,
        teams: 1,
        telegram: 1,
      },
    });
  });

  it("continues orphan monitoring after a full revoked candidate page", async () => {
    const fixture = await trackFixture(seedFixture("paginated-orphan"));

    const response = await accept(
      stateClient().monitor({ body: { event_ids: [...fixture.eventIds] } }),
      [500],
    );

    expect(response.body).toStrictEqual({
      error: "Internal server error",
    });
    expect(
      context.mocks.sentry.captureException.mock.calls.at(-1)?.[0],
    ).toMatchObject({
      name: "OrphanedQueuedChatEventsError",
      code: "ORPHANED_QUEUED_CHAT_MESSAGES",
      orphanedMessages: 1,
      orphanedMessagesBySource: { slack: 1 },
    });
  });

  it("does not flag input.automation without legacy encrypted params", async () => {
    const fixture = await trackFixture(seedFixture("orphaned-automation"));

    const response = await accept(
      stateClient().monitor({ body: { event_ids: [fixture.eventId] } }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      orphanedMessages: 0,
    });
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not alert for a newly queued event below the age threshold", async () => {
    const fixture = await trackFixture(seedFixture("queued-integration"));

    const response = await accept(
      stateClient().monitor({ body: { event_ids: [fixture.eventId] } }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      orphanedMessages: 0,
    });
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("ignores orphaned events outside the recent stale window", async () => {
    const fixture = await trackFixture(seedFixture("old-orphan"));

    const response = await accept(
      stateClient().monitor({ body: { event_ids: [fixture.eventId] } }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      orphanedMessages: 0,
    });
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not expose scoped monitoring in production", async () => {
    mockEnv("ENV", "production");

    const response = await accept(
      stateClient().monitor({
        body: { event_ids: ["00000000-0000-4000-8000-000000000001"] },
      }),
      [404],
    );

    expect(response.body).toBe("Not found");
  });
});
