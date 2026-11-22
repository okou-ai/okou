import { sessionOutputChannelName } from "@okouai/api-contracts/validators/realtime";
import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  promptEvent,
  assistantEvent,
  completedEvent,
  RUN_THREAD_ID,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function conversation() {
  const user = { id: "harbor-reader", fullName: "Harbor Reader" };
  const org = { id: "org_harbor", name: "Harbor" };
  const run = crypto.randomUUID(),
    event = crypto.randomUUID();
  const channel = sessionOutputChannelName(user.id, org.id, run);
  const events = [
    promptEvent({
      id: crypto.randomUUID(),
      seqId: 1,
      text: "Prepare the report",
      runId: run,
    }),
  ];
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    activeRunIds: [run],
    chatEvents: events,
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    auth: {
      user,
      organization: { activeOrg: org, memberships: [{ id: org.id }] },
    },
  });
  await screen.findByText("Prepare the report");
  const subscribed = () => {
    return context.mocks.ably.hasSubscriptionOnChannel(channel, run);
  };
  await waitFor(() => {
    expect(subscribed()).toBeTruthy();
  });
  let index = 0;
  const createdAt = "2026-08-01T10:00:02.000Z";
  return {
    subscribed,
    chunk(delta: string) {
      context.mocks.ably.triggerOnChannel(channel, run, {
        threadId: RUN_THREAD_ID,
        runId: run,
        eventId: event,
        runEventId: "report-event",
        createdAt,
        chunkIndex: index++,
        delta,
      });
    },
    persist(text: string) {
      events.push(
        assistantEvent({ id: event, runId: run, seqId: 2, text, createdAt }),
      );
      createChatEvent(RUN_THREAD_ID);
    },
    finish() {
      events.push(
        completedEvent({ id: crypto.randomUUID(), runId: run, seqId: 3 }),
      );
      createChatEvent(RUN_THREAD_ID);
    },
  };
}
const url = "https://app.okou.ai/computer-use/authorize/harbor-report";
const card = () => {
  return screen.findByTestId("computer-use-authorization-card");
};
test("chat-session-output-stream-004 the same authorization card survives added paragraphs and finalization", async () => {
  const api = await conversation();
  api.chunk(url + " ");
  const request = await card();
  api.chunk("Review this request.");
  await screen.findByText(/Review this request/);
  await expect(card()).resolves.toBe(request);
  api.chunk("\n\nWork can continue.");
  await screen.findByText("Work can continue.");
  await expect(card()).resolves.toBe(request);
  api.persist(url + " Review this request.\n\nWork can continue.");
  api.finish();
  await waitFor(() => {
    expect(api.subscribed()).toBeFalsy();
  });
  await expect(card()).resolves.toBe(request);
});
test("chat-session-output-stream-006 closing a Markdown link presents authorization during the active run", async () => {
  const api = await conversation();
  api.chunk("[Review access](" + url);
  await screen.findByText(/Review access/);
  expect(screen.queryByTestId("computer-use-authorization-card")).toBeNull();
  api.chunk(")");
  await expect(card()).resolves.toBeVisible();
  expect(screen.getAllByTestId("computer-use-authorization-card")).toHaveLength(
    1,
  );
  expect(api.subscribed()).toBeTruthy();
});
test("chat-session-output-stream-009 the approval destination includes its final signature underscore", async () => {
  const api = await conversation();
  const link = "https://app.link.com/approve/harbor?signature=abc";
  api.chunk(link);
  await screen.findByText(link);
  api.chunk("_ ");
  const purchase = await findFastControl("link", "Review purchase");
  expect(purchase).toHaveAttribute("href", link + "_");
  api.chunk("Review the order details.");
  await screen.findByText(/Review the order details/);
});
test("chat-session-output-stream-011 completing the run ends its live subscription after displaying the durable report", async () => {
  const api = await conversation();
  api.persist("The complete report");
  await screen.findByText("The complete report");
  expect(api.subscribed()).toBeTruthy();
  api.finish();
  await waitFor(() => {
    expect(api.subscribed()).toBeFalsy();
  });
  expect(screen.getByText("The complete report")).toBeVisible();
});
