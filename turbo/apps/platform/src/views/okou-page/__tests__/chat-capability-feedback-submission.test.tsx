import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  context,
  findButton,
  installCapabilityChat,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";

const SUBMISSION_PASSAGE = "The rollout can begin after the final review.";

async function composeFeedback(comment: string): Promise<HTMLElement> {
  await selectPassage("rollout can begin after the final review");
  const editor = await quoteSelectedPassage();
  await userEvent.setup({ delay: null }).type(editor, comment);
  return editor;
}

function expectCapturedFeedback(send: CapturedChatSend, comment: string): void {
  expect(send.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "feedback",
        quote: "rollout can begin after the final review",
        note: [{ type: "text", text: comment }],
      }),
    ]),
  );
}

test("Reconcile inline feedback when the selected model is unavailable", async () => {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(SUBMISSION_PASSAGE),
    onSend(send) {
      sends.push(send);
    },
  });
  context.mocks.data.userModelPreference({
    selectedModel: "gpt-5.6-sol",
    serviceTier: null,
    modelSettings: {},
    selectedVideoModel: null,
    selectedImageModel: null,
    updatedAt: "2026-07-31T10:00:00.000Z",
  });
  context.mocks.data.personalModelProviders([]);

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const comment = "Keep this feedback while choosing an available model.";
  const editor = await composeFeedback(comment);
  click(await findButton("Send"));

  const sent = await waitForSend(sends, 1);
  expectCapturedFeedback(sent, comment);
  expect(editor).not.toBeInTheDocument();
  const submittedComment = await screen.findByText(comment);
  expect(submittedComment).toBeVisible();
});
