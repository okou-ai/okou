import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  feedbackItems,
  findButton,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const PASSAGE = "The launch plan has three careful stages.";
const COMMENT = "Explain why the second stage needs approval.";

test("Reconcile inline feedback when the selected model is unavailable", async () => {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(PASSAGE),
    selectedModel: "retired-model-unavailable",
    onSend(send) {
      sends.push(send);
    },
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await selectPassage(PASSAGE);
  const note = await quoteSelectedPassage();
  const user = userEvent.setup({ delay: null });
  await user.type(note, COMMENT);

  click(await findButton("Send"));

  const sent = await waitForSend(sends, 1);
  expect(sent.userMessage?.parts).toContainEqual(
    expect.objectContaining({
      type: "feedback",
      quote: PASSAGE,
      note: [{ type: "text", text: COMMENT }],
    }),
  );
  await waitFor(() => {
    expect(feedbackItems()).toHaveLength(0);
  });
  expect(
    screen.queryByRole("textbox", { name: "Ask or comment on this quote" }),
  ).not.toBeInTheDocument();
  const thread = await readyChat();
  await expect(within(thread).findByText(COMMENT)).resolves.toBeVisible();
});
