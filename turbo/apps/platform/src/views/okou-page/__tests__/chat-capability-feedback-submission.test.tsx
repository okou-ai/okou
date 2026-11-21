import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { selectPassage } from "./chat-capability-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  findButton,
  findEnabledButton,
  promptEvent,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";
const context = testContext();
test("chat-capability-feedback-submission-001 sending a quoted correction clears the editor and posts it to this chat", async () => {
  const runId = crypto.randomUUID(),
    passage = "Inspect the east loading dock",
    comment = "Please use the west loading dock.";
  const unavailable = "retired-dispatch-model";
  const submission = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    onSendRequest(body) {
      if ((body.threadId ?? body.clientThreadId) === RUN_THREAD_ID) {
        submission.resolve(body.userMessage);
      }
    },
    selectedModel: unavailable,
    chatEvents: [
      promptEvent({
        id: runId,
        runId,
        seqId: 1,
        text: "Check the dispatch instructions",
      }),
      assistantEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 2,
        text: passage,
      }),
      completedEvent({ id: crypto.randomUUID(), runId, seqId: 3 }),
    ],
  });
  context.mocks.data.userModelPreference({
    selectedModel: unavailable,
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: null,
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  const source = await screen.findByText(passage);
  const transcript = source.closest<HTMLElement>("[data-message-container]")!;
  await selectPassage(passage);
  click(await findButton("Quote"));
  const note = await screen.findByRole("textbox", {
    name: "Ask or comment on this quote",
  });
  // The note shares a contenteditable with the quote. Select-all would replace both.
  await userEvent.setup({ delay: null }).type(note, comment);
  click(await findEnabledButton("Send"));
  const document = await submission.promise;
  const feedback = document?.parts.find((part) => {
    return part.type === "feedback";
  });
  expect(feedback?.quote).toBe(passage);
  expect(feedback?.note).toStrictEqual([{ type: "text", text: comment }]);
  const posted = await within(transcript).findByText(comment);
  const row = posted.closest<HTMLElement>("[data-chat-scroll-anchor-event-id]");
  expect(row).toBeInTheDocument();
  expect(row).toHaveTextContent(passage);
  expect(posted).toBeVisible();
  await waitFor(() => {
    return expect(
      screen.queryByRole("textbox", { name: "Ask or comment on this quote" }),
    ).toBeNull();
  });
});
