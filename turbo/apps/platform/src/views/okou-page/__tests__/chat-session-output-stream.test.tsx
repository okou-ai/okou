import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  sessionOutputChannelName,
  type SessionOutputDelta,
} from "@okouai/api-contracts/contracts/realtime";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import {
  hasSubscriptionOnChannel,
  triggerAblyChannelEvent,
} from "../../../mocks/ably.ts";
import {
  assistantEvent,
  completedEvent,
  context,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  findWorkHistoryToggle,
  findLink,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const RUN_ID = "d0000000-0000-4000-a000-000000000851";
const EVENT_ID = "d0000000-0000-4000-a000-000000000852";
const CHANNEL = sessionOutputChannelName(
  "test-user-123",
  "org_default",
  RUN_ID,
);

function activeRun(additionalRunIds: readonly string[] = []) {
  const events = [
    promptEvent({
      id: "stream-prompt",
      runId: RUN_ID,
      seqId: 1,
      text: "Prepare a report",
    }),
  ];
  installRunChat({
    chatEvents: events,
    activeRunIds: [RUN_ID, ...additionalRunIds],
  });
  return events;
}

function push(chunkIndex: number, delta: string, eventId = EVENT_ID): void {
  const payload: SessionOutputDelta = {
    threadId: RUN_THREAD_ID,
    runId: RUN_ID,
    eventId,
    runEventId: "api-first:attempt:2",
    createdAt: "2026-08-01T10:00:02.000Z",
    chunkIndex,
    delta,
  };
  act(() => {
    triggerAblyChannelEvent(CHANNEL, RUN_ID, payload);
  });
}

async function subscribed(): Promise<void> {
  await waitFor(() => {
    expect(hasSubscriptionOnChannel(CHANNEL, RUN_ID)).toBeTruthy();
  });
}

async function setupActiveOutputStream() {
  const events = activeRun();
  await setupPage({ context, path: RUN_PATH });
  await subscribed();
  return events;
}

function publishDurableReport(events: ReturnType<typeof activeRun>) {
  events.push(
    assistantEvent({
      id: EVENT_ID,
      runId: RUN_ID,
      seqId: 2,
      text: "The complete report",
    }),
  );
  publishRunUpdate();
}

test("Append live text deltas during a run", async () => {
  await setupActiveOutputStream();
  push(0, "Preparing");
  await expect(screen.findByText("Preparing")).resolves.toBeVisible();
  push(3, " the report");
  await expect(
    screen.findByText("Preparing the report"),
  ).resolves.toBeVisible();
});

test("Reconcile live text with the durable assistant event", async () => {
  const events = await setupActiveOutputStream();
  push(0, "Preparing");
  push(3, " the report");
  await expect(
    screen.findByText("Preparing the report"),
  ).resolves.toBeVisible();
  publishDurableReport(events);
  await expect(screen.findByText("The complete report")).resolves.toBeVisible();
  expect(screen.queryByText("Preparing the report")).not.toBeInTheDocument();
  push(0, "A late first packet");
  push(4, "A late delta");
  expect(screen.queryByText(/A late/)).not.toBeInTheDocument();
  expect(screen.getAllByText("The complete report")).toHaveLength(1);
});

test("A growing action URL becomes a card as soon as a boundary arrives", async () => {
  const events = activeRun();
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await subscribed();

  const prefix = "https://app.okou.ai/computer-use/authorize/";
  let url = `${prefix}abcdefghijklmnopqrstuvwxyz`;
  push(0, url);
  await expect(screen.findByText(url)).resolves.toBeInTheDocument();
  expect(screen.queryByText("Computer Use authorization")).toBeNull();

  for (const [index, delta] of [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "0123456789",
  ].entries()) {
    url += delta;
    push(index + 1, delta);
    await expect(screen.findByText(url)).resolves.toBeInTheDocument();
    expect(screen.queryByText("Computer Use authorization")).toBeNull();
  }

  // A trailing period is still ambiguous: it may be part of the next URL byte.
  push(3, ".");
  await waitFor(() => {
    expect(
      document.querySelector("[data-chat-thread-container-id]"),
    ).toHaveTextContent(`${url}.`);
  });
  expect(screen.queryByText("Computer Use authorization")).toBeNull();

  push(4, " ");
  await expect(
    screen.findByText("Computer Use authorization"),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Computer Use authorization")).toHaveLength(1);

  const content = `${url}. Read more`;
  push(5, "Read more");
  await expect(screen.findByText(/Read more/u)).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Computer Use authorization")).toHaveLength(1);

  events.push(
    assistantEvent({
      id: EVENT_ID,
      runId: RUN_ID,
      seqId: 2,
      text: `${content} (finished)`,
    }),
  );
  publishRunUpdate();
  await waitFor(() => {
    expect(screen.getByText(/Read more \(finished\)/u)).toBeInTheDocument();
    expect(screen.getAllByText("Computer Use authorization")).toHaveLength(1);
  });
});

test("A closed Markdown action link becomes a card before the run finishes", async () => {
  await setupActiveOutputStream();
  const url =
    "https://app.okou.ai/computer-use/authorize/abcdefghijklmnopqrstuvwxyz";
  push(0, `[Authorize](<${url}>)`);
  await expect(
    screen.findByText("Computer Use authorization"),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Computer Use authorization")).toHaveLength(1);
});

test("A trailing bare URL becomes a card when its final event arrives", async () => {
  const events = activeRun();
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await subscribed();

  const url =
    "https://app.okou.ai/computer-use/authorize/abcdefghijklmnopqrstuvwxyz";
  push(0, url);
  await expect(screen.findByText(url)).resolves.toBeInTheDocument();
  expect(screen.queryByText("Computer Use authorization")).toBeNull();

  events.push(
    assistantEvent({ id: EVENT_ID, runId: RUN_ID, seqId: 2, text: url }),
  );
  publishRunUpdate();
  await expect(
    screen.findByText("Computer Use authorization"),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Computer Use authorization")).toHaveLength(1);
});

test("An explicit artifact preview appears when its Markdown link closes", async () => {
  const events = activeRun();
  await setupPage({ context, path: RUN_PATH });
  await subscribed();

  const content = "![Brief preview](https://a.okou.io/a1b2c3d4e5.pdf)";
  push(0, content.slice(0, -1));
  const cardLabel = "Open pdf preview for a1b2c3d4e5.pdf";
  await expect(
    screen.findByText(/Brief preview/u),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByLabelText(cardLabel)).toBeNull();

  push(1, ")");
  await expect(screen.findByLabelText(cardLabel)).resolves.toBeInTheDocument();
  expect(screen.getAllByLabelText(cardLabel)).toHaveLength(1);

  events.push(
    assistantEvent({
      id: EVENT_ID,
      runId: RUN_ID,
      seqId: 2,
      text: `${content}\n\nPreview complete`,
    }),
  );
  publishRunUpdate();
  await waitFor(() => {
    expect(screen.getByText("Preview complete")).toBeInTheDocument();
    expect(screen.getAllByLabelText(cardLabel)).toHaveLength(1);
  });
});

test("Unsubscribe from output after the durable run completes", async () => {
  const events = await setupActiveOutputStream();
  publishDurableReport(events);
  await expect(screen.findByText("The complete report")).resolves.toBeVisible();
  events.push(
    completedEvent({ id: "stream-completed", runId: RUN_ID, seqId: 3 }),
  );
  publishRunUpdate();
  await waitFor(() => {
    expect(hasSubscriptionOnChannel(CHANNEL, RUN_ID)).toBeFalsy();
  });
});

test("A viewer missing chunk zero waits for the durable output and can receive the next block", async () => {
  const events = activeRun();
  await setupPage({ context, path: RUN_PATH });
  await subscribed();
  push(1, "Missing beginning");
  const nextEventId = "d0000000-0000-4000-a000-000000000853";
  push(0, "The next block", nextEventId);
  await expect(screen.findByText("The next block")).resolves.toBeVisible();
  expect(screen.queryByText("Missing beginning")).not.toBeInTheDocument();
  events.push(
    assistantEvent({
      id: EVENT_ID,
      runId: RUN_ID,
      seqId: 2,
      text: "Recovered complete block",
    }),
  );
  publishRunUpdate();
  click(await findWorkHistoryToggle("collapsed"));
  await expect(
    screen.findByText("Recovered complete block"),
  ).resolves.toBeVisible();
});

test("Changing runs replaces the channel and leaving the thread cancels the subscription", async () => {
  const nextRunId = "d0000000-0000-4000-a000-000000000854";
  const events = activeRun([nextRunId]);
  await setupPage({ context, path: RUN_PATH });
  await subscribed();
  const nextChannel = sessionOutputChannelName(
    "test-user-123",
    "org_default",
    nextRunId,
  );
  events.push(
    completedEvent({ id: "first-finished", runId: RUN_ID, seqId: 2 }),
    promptEvent({
      id: "next-prompt",
      runId: nextRunId,
      seqId: 3,
      text: "Start the next report",
    }),
  );
  publishRunUpdate();
  await waitFor(() => {
    expect(hasSubscriptionOnChannel(nextChannel, nextRunId)).toBeTruthy();
    expect(hasSubscriptionOnChannel(CHANNEL, RUN_ID)).toBeFalsy();
  });
  click(await findLink("Agents"));
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  expect(hasSubscriptionOnChannel(nextChannel, nextRunId)).toBeFalsy();
});
