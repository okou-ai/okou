import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { sessionOutputChannelName } from "@okouai/api-contracts/validators/realtime";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  RUN_THREAD_ID,
  promptEvent,
  assistantEvent,
  completedEvent,
} from "./chat-run-test-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext(),
  user = Object.freeze({ id: "markdown-reader", fullName: "Coastal Reader" }),
  org = Object.freeze({ id: "org_markdown", name: "Harbor" });
async function fromInstructions(run: string, finished: boolean) {
  const events = [
    promptEvent({
      id: crypto.randomUUID(),
      seqId: 1,
      text: "Read the harbor report",
      runId: run,
    }),
  ];
  if (finished) {
    events.push(
      assistantEvent({
        id: crypto.randomUUID(),
        seqId: 2,
        text: "Harbor reply is complete",
        runId: run,
      }),
      completedEvent({ id: crypto.randomUUID(), seqId: 3, runId: run }),
    );
  }
  mockChatLifecycle(context, {
    threadTitle: "Harbor report chat",
    threadId: RUN_THREAD_ID,
    chatEvents: events,
    activeRunIds: finished ? [] : [run],
  });
  await setupPage({
    context,
    path: "/?settings=my-okou",
    auth: {
      user,
      organization: { activeOrg: org, memberships: [{ id: org.id }] },
    },
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: true,
      [FeatureSwitchKey.OkouDebug]: true,
    },
  });
  const settings = await screen.findByRole("dialog");
  const instructions = await findFastControl("tab", "Instructions", settings);
  click(instructions);
  await waitFor(() => {
    expect(new URL(location.href).searchParams.get("focus")).toBe(
      "instructions",
    );
    expect(instructions).toHaveAttribute("aria-selected", "true");
  });
  click(await findFastControl("button", "Close", settings));
  click(await findFastControl("link", /Harbor report chat/));
  await screen.findByText("Read the harbor report");
  expect(location.pathname).toBe("/chats/" + RUN_THREAD_ID);
}
test("markdown-parser-isolation-002 an unfinished reply keeps bold and literal plus signs after visiting Instructions", async () => {
  const run = crypto.randomUUID();
  await fromInstructions(run, false);
  const channel = sessionOutputChannelName(user.id, org.id, run),
    eventId = crypto.randomUUID();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(channel, run),
    ).toBeTruthy();
  });
  function chunk(chunkIndex: number, delta: string) {
    context.mocks.ably.triggerOnChannel(channel, run, {
      threadId: RUN_THREAD_ID,
      runId: run,
      eventId,
      runEventId: "harbor-progress",
      createdAt: "2026-08-01T09:00:00Z",
      chunkIndex,
      delta,
    });
  }
  chunk(0, "**Status** ++Reply");
  await screen.findByText(/\+\+Reply$/);
  chunk(1, "+");
  const literal = await screen.findByText(/\+\+Reply\+$/),
    bubble = literal.closest('[data-role="assistant"]');
  if (!(bubble instanceof HTMLElement)) {
    throw new Error("No rendered assistant reply");
  }
  expect(
    within(bubble).getByText("Status").closest("strong"),
  ).toBeInTheDocument();
  expect(bubble.querySelector("u")).toBeNull();
});
test("markdown-parser-isolation-004 opening the completed run's logs preserves its distinct rich text elements", async () => {
  const run = "a0000000-0000-4000-a000-000000000001";
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(200, {
      events: [
        {
          sequenceNumber: 1,
          createdAt: "2026-08-01T09:00:00Z",
          eventType: "assistant",
          eventData: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "**Activity** ++literal++ <u>Log underline</u>",
                },
              ],
            },
          },
        },
      ],
      hasMore: false,
      lastEventSequence: 1,
      status: "completed",
    });
  });
  await fromInstructions(run, true);
  await screen.findByText("Harbor reply is complete");
  click(await findFastControl("link", "View run logs"));
  await waitFor(() => {
    expect(location.pathname).toBe("/activities/" + run);
  });
  const strong = await screen.findByText("Activity", { selector: "strong" });
  expect(strong).toBeVisible();
  await expect(screen.findByText(/\+\+literal\+\+/)).resolves.toBeVisible();
  await expect(
    screen.findByText("Log underline", { selector: "u" }),
  ).resolves.toBeVisible();
});
