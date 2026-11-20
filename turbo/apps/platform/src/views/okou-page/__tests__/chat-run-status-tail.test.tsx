import { screen, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  promptEvent,
  completedEvent,
  createChatRunFixtures,
  RUN_PATH,
  sendText,
  findEnabledButton,
} from "./chat-run-test-fixtures.ts";
import { publicArtifactUrl } from "./chat-attachment-test-helpers.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const runId = "70755889-0650-4423-af5f-4469cfa70880";
const result = "The dependency check identified two owners.";
const file = "owners.md";
const generic = "This run couldn't finish";
function outputs(): MockChatEventInput[] {
  return [
    promptEvent({ id: "check", seqId: 1, runId, text: "Check ownership." }),
    assistantEvent({
      id: "ownership",
      seqId: 2,
      runId,
      text: result + "\n\n[" + file + "](" + publicArtifactUrl(file) + ")",
    }),
  ];
}
function failedHistory(): MockChatEventInput[] {
  return [
    ...outputs(),
    {
      id: "baseline-failure",
      runId,
      seqId: 3,
      role: "assistant",
      runLifecycleEvent: "failed",
      createdAt: "2026-08-01T10:00:03Z",
      content: null,
      error: "Run failed",
      failureReason: "unknown",
    },
  ];
}
function retainedAnswer() {
  const turn = screen
    .getByText(result)
    .closest<HTMLElement>('[data-role="assistant"]')!;
  expect(within(turn).getByText(file)).toBeVisible();
  expect(within(turn).getByLabelText("Copy message")).toBeEnabled();
}

async function openFailedCheck() {
  const acknowledgement = context.mocks.deferred<void>();
  const service = installRunChat({
    chatEvents: failedHistory(),
    sendGate: acknowledgement.promise,
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText(generic);
  retainedAnswer();
  return { acknowledgement, service };
}

test("chat-run-status-tail-003 clears the old failure as the unacknowledged continuation starts thinking", async () => {
  const { acknowledgement } = await openFailedCheck();
  await sendText("Continue checking");
  await screen.findByText("Thinking...");
  expect(
    screen.getByText("Continue checking", { selector: '[data-role="user"] *' }),
  ).toBeVisible();
  expect(screen.queryByText(generic)).toBeNull();
  retainedAnswer();
  acknowledgement.resolve();
});

test("chat-run-status-tail-004 places the acknowledged continuation's timeout in the status tail", async () => {
  const { acknowledgement, service } = await openFailedCheck();
  await sendText("Continue checking");
  await screen.findByText("Thinking...");
  acknowledgement.resolve();
  await findEnabledButton("Stop");
  service.failRun("Execution deadline exceeded", "execution_timeout");
  const failure = await screen.findByText("Time limit reached");
  expect(failure.closest("[data-chat-run-status-tail]")).toBeInTheDocument();
  expect(screen.queryByText(generic)).toBeNull();
  expect(screen.queryByText("Thinking...")).toBeNull();
  expect(screen.getAllByTestId("chat-event-actions")).toHaveLength(1);
  retainedAnswer();
});

test("chat-run-status-tail-008 retires the completed run's followups on a pending new check", async () => {
  const gate = context.mocks.deferred<void>();
  installRunChat({
    sendGate: gate.promise,
    chatEvents: [
      ...outputs(),
      completedEvent({ id: "done", seqId: 3, runId }),
      {
        id: "next-step",
        eventType: "output.followups",
        content: null,
        seqId: 4,
        createdAt: "2026-08-01T10:00:04Z",
        runId,
        followups: [{ kind: "talk", prompt: "Summarize the check" }],
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  const group = await screen.findByRole("group", { name: "Keep going" });
  expect(within(group).getByText("Summarize the check")).toBeVisible();
  await sendText("Start another check");
  await screen.findByText("Thinking...");
  expect(
    screen.getByText("Start another check", {
      selector: '[data-role="user"] *',
    }),
  ).toBeVisible();
  expect(screen.queryByRole("group", { name: "Keep going" })).toBeNull();
  retainedAnswer();
  gate.resolve();
});
