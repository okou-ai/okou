import {
  userModelPreferenceContract,
  type UserModelPreferenceResponse,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { fireEvent, screen } from "@testing-library/react";
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

test("Submit inline feedback once without losing composed text", async () => {
  const sends: CapturedChatSend[] = [];
  const modelPreference = context.mocks.deferred<UserModelPreferenceResponse>();
  installCapabilityChat({
    events: completedConversation(SUBMISSION_PASSAGE),
    onSend(send) {
      sends.push(send);
    },
  });
  context.mocks.api(userModelPreferenceContract.get, async ({ respond }) => {
    const preference = await modelPreference.promise;
    return respond(200, preference);
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const comment = "Preserve this comment while choosing the model.";
  await composeFeedback(comment);
  click(await findButton("Send"));

  expect(sends).toHaveLength(0);
  modelPreference.resolve({
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    modelSettings: {},
    selectedVideoModel: null,
    selectedImageModel: null,
    updatedAt: "2026-08-01T10:00:00.000Z",
  });

  const sent = await waitForSend(sends, 1);
  expectCapturedFeedback(sent, comment);
  expect(sends).toHaveLength(1);
});

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

test("Submit inline feedback once after IME composition finishes", async () => {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(SUBMISSION_PASSAGE),
    onSend(send) {
      sends.push(send);
    },
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  let editor = await composeFeedback("承認内容を確認中");
  fireEvent.compositionStart(editor);
  fireEvent.keyDown(editor, {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });

  expect(sends).toHaveLength(0);
  expect(editor).toHaveTextContent("承認内容を確認中");

  fireEvent.compositionEnd(editor, { data: "確認済み" });
  editor = screen.getByRole("textbox", {
    name: "What should change about this?",
  });
  const completedComment = "承認内容を確認済みです";
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Backspace}".repeat("承認内容を確認中".length));
  await user.type(editor, completedComment);
  fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });

  const sent = await waitForSend(sends, 1);
  expectCapturedFeedback(sent, completedComment);
  expect(sends).toHaveLength(1);
});
