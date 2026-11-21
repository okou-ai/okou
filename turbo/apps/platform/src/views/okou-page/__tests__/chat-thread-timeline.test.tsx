import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  promptEvent,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
const context = testContext();
function stamp(day: number, hour: number, minute: number) {
  return new Date(2026, 9, day, hour, minute).toISOString();
}
async function open(events: MockChatEventInput[]) {
  mockNow(new Date(2026, 9, 28, 12), context.signal);
  createChatRunFixtures(context).installRunChat({ chatEvents: events });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
}
function appearsBefore(first: Element, second: Element) {
  return Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}
test("chat-thread-timeline-002 a thread containing only this morning's message needs no Today divider", async () => {
  const runId = crypto.randomUUID(),
    createdAt = stamp(28, 8, 12);
  await open([
    promptEvent({
      id: "today-note",
      runId,
      seqId: 1,
      text: "Morning reconciliation",
      createdAt,
    }),
    completedEvent({ id: "today-finished", runId, seqId: 2, createdAt }),
  ]);
  await screen.findByText("Morning reconciliation");
  expect(screen.queryByRole("separator", { name: "Today" })).toBeNull();
});
test("chat-thread-timeline-004 a turn crossing midnight places today's divider before the early user message", async () => {
  const runId = crypto.randomUUID(),
    late = stamp(27, 23, 59),
    early = stamp(28, 0, 1);
  await open([
    promptEvent({
      id: "late-request",
      runId,
      seqId: 1,
      text: "Record the evening count",
      createdAt: late,
    }),
    promptEvent({
      id: "early-note",
      runId,
      seqId: 2,
      text: "Record the opening inventory",
      createdAt: early,
    }),
    completedEvent({ id: "counted", runId, seqId: 3, createdAt: early }),
  ]);
  const morningNote = await screen.findByText("Record the opening inventory");
  const request = screen.getByText("Record the evening count");
  expect(
    appearsBefore(
      screen.getByRole("separator", { name: "Yesterday" }),
      request,
    ),
  ).toBeTruthy();
  expect(
    appearsBefore(request, screen.getByRole("separator", { name: "Today" })),
  ).toBeTruthy();
  expect(
    appearsBefore(
      screen.getByRole("separator", { name: "Today" }),
      morningNote,
    ),
  ).toBeTruthy();
});
test("chat-thread-timeline-006 an assistant reply opens yesterday's section before today's next user turn", async () => {
  const first = crypto.randomUUID(),
    next = crypto.randomUUID();
  await open([
    promptEvent({
      id: "oct26",
      runId: first,
      seqId: 1,
      text: "Send the quarterly totals",
      createdAt: stamp(26, 23, 50),
    }),
    assistantEvent({
      id: "oct27",
      runId: first,
      seqId: 2,
      text: "The quarterly totals are available",
      createdAt: stamp(27, 8, 0),
    }),
    completedEvent({
      id: "totals-done",
      runId: first,
      seqId: 3,
      createdAt: stamp(27, 8, 2),
    }),
    promptEvent({
      id: "oct28",
      runId: next,
      seqId: 4,
      text: "Archive the result",
      createdAt: stamp(28, 8, 25),
    }),
    completedEvent({
      id: "archived",
      runId: next,
      seqId: 5,
      createdAt: stamp(28, 8, 26),
    }),
  ]);
  const archive = await screen.findByText("Archive the result");
  const reply = screen.getByText("The quarterly totals are available");
  expect(
    appearsBefore(
      screen.getByText("Send the quarterly totals"),
      screen.getByRole("separator", { name: "Yesterday" }),
    ),
  ).toBeTruthy();
  expect(
    appearsBefore(screen.getByRole("separator", { name: "Yesterday" }), reply),
  ).toBeTruthy();
  expect(
    appearsBefore(reply, screen.getByRole("separator", { name: "Today" })),
  ).toBeTruthy();
  expect(
    appearsBefore(screen.getByRole("separator", { name: "Today" }), archive),
  ).toBeTruthy();
});
