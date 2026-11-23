import { publicArtifactUrl } from "./chat-attachment-test-helpers.ts";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  findEnabledButton,
  promptEvent,
  publishRunUpdate,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const runId = "324cc3fd-7222-4615-984c-9edc05f33929";
const { installRunChat } = createChatRunFixtures(context);

test("chat-run-steer-003 retains the selected prompt and its changing status when a run claims it", async () => {
  const text = "Review the API";
  const queued = promptEvent({ id: "before-claim", text, seqId: 1 });
  const events = [queued];
  installRunChat({ chatEvents: events });
  await setupPage({ context, path: RUN_PATH });
  const waiting = await screen.findByText("queue...");
  const prompt = screen.getByText(text);
  const range = document.createRange();
  range.setStartBefore(prompt);
  range.setEndAfter(waiting.closest('[data-role="assistant-thinking"]')!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  expect(selection.toString()).toMatch(/^Review the API.*queue\.\.\.$/s);
  events.push({
    ...queued,
    id: "claimed",
    seqId: 2,
    runId,
    revokesEventId: queued.id,
  });
  publishRunUpdate();
  await screen.findByText("Thinking...");
  expect(screen.getAllByText(text)).toHaveLength(1);
  expect(screen.queryByText("queue...")).toBeNull();
  expect(selection.toString()).toMatch(/^Review the API.*Thinking\.\.\.$/s);
});

test("chat-run-steer-005 interrupts the active run while its queued follow-up remains in the conversation", async () => {
  const followup = "List the remaining decisions.";
  const stoppedAt = "The rollout schedule has two stages.";
  const events = [
    promptEvent({
      id: "start",
      seqId: 1,
      runId,
      text: "Audit the release plan.",
    }),
    assistantEvent({
      id: "progress",
      seqId: 2,
      runId,
      text: "Reviewing the rollout schedule.",
    }),
    promptEvent({ id: "follow-up", seqId: 3, text: followup }),
  ];
  installRunChat({
    activeRunIds: [runId],
    chatEvents: events,
    onInterruptEventAppend: ({ interruptsRunId }) => {
      // This final progress update is delivered in the same authoritative feed
      // as the interrupt. The optimistic Stop action cannot render it.
      if (interruptsRunId === runId) {
        events.push(
          assistantEvent({
            id: "final-progress",
            seqId: 4,
            runId,
            text: stoppedAt,
          }),
        );
      }
    },
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText(followup);
  await screen.findByText("Thinking...");
  click(await findEnabledButton("Stop"));
  await screen.findByText(stoppedAt);
  await screen.findByText("queue...");
  expect(screen.getByText(followup)).toBeVisible();
  expect(screen.queryByRole("listitem", { name: "Queued message" })).toBeNull();
});

test("An unclaimed steer shows Thinking before delivery and keeps both timed results when claimed", async () => {
  const at = (sec: number) => {
    return new Date(Date.UTC(2026, 8, 9, 10, 0, sec)).toISOString();
  };
  const output = (
    sec: number,
    id: string,
    text: string,
    file: string,
    seqId: number,
  ) => {
    return assistantEvent({
      id,
      runId,
      seqId,
      createdAt: at(sec),
      text: text + "\n\n[" + file + "](" + publicArtifactUrl(file) + ")",
    });
  };
  const events = [
    promptEvent({
      id: "api-request",
      text: "Review the API",
      runId,
      seqId: 1,
      createdAt: at(0),
    }),
    output(8, "review", "Review complete.", "review.md", 2),
  ];
  installRunChat({ activeRunIds: [runId], chatEvents: events });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Review complete.");
  const queueItem = promptEvent({
    id: "waiting-on-errors",
    text: "Check error handling.",
    seqId: 3,
    createdAt: at(12),
  });
  events.push(queueItem);
  publishRunUpdate();
  await screen.findByText("Check error handling.");
  await screen.findByText("Thinking...");
  expect(screen.queryByRole("listitem", { name: "Queued message" })).toBeNull();
  expect(screen.queryByText("queue...")).toBeNull();
  expect(screen.getByText("Worked for 12 sec")).toBeInTheDocument();
  events.push({
    ...queueItem,
    id: "delivered-to-review",
    runId,
    seqId: 4,
    revokesEventId: queueItem.id,
  });
  publishRunUpdate();

  const steer = screen.getByText("Check error handling.");
  events.push(
    output(18, "followup", "Error paths checked.", "errors.md", 5),
    completedEvent({ id: "finished", runId, seqId: 6, createdAt: at(20) }),
  );
  publishRunUpdate();
  const followup = await screen.findByText("Error paths checked.");
  await waitFor(() => {
    return expect(screen.queryByText("Thinking...")).toBeNull();
  });
  const initial = screen.getByText("Review complete.");
  expect(
    initial.compareDocumentPosition(steer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    steer.compareDocumentPosition(followup) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  for (const [message, file] of [
    [initial, "review.md"],
    [followup, "errors.md"],
  ] as const) {
    const result = within(
      message.closest<HTMLElement>('[data-role="assistant"]')!,
    );
    expect(result.getByText(file)).toBeInTheDocument();
    expect(result.getByLabelText("Copy message")).toBeInTheDocument();
  }
  await screen.findByText("Worked for 12 sec");
  await screen.findByText("Worked for 8 sec");
});
