import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  findButton,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  selectAcrossPassages,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import { queryButton } from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const FIRST_PASSAGE = "The launch plan has three careful stages.";
const SECOND_PASSAGE = "The rollout review waits for the final checklist.";

test("Offer passage actions only for a valid assistant selection", async () => {
  installCapabilityChat({
    events: completedConversation(FIRST_PASSAGE, SECOND_PASSAGE),
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  await selectPassage(FIRST_PASSAGE);
  await expect(findButton("Copy")).resolves.toBeInTheDocument();
  await expect(findButton("Quote")).resolves.toBeInTheDocument();
  await expect(findButton("Forward")).resolves.toBeInTheDocument();

  await selectAcrossPassages(FIRST_PASSAGE, SECOND_PASSAGE);
  expect(queryButton("Copy")).not.toBeInTheDocument();
  expect(queryButton("Quote")).not.toBeInTheDocument();
  expect(queryButton("Forward")).not.toBeInTheDocument();

  await selectPassage(FIRST_PASSAGE);
  const user = userEvent.setup({ delay: null });
  await user.keyboard("q");

  const note = await screen.findByRole("textbox", {
    name: "Ask or comment on this quote",
  });
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  });
  const feedbackItem = note.closest<HTMLElement>("[data-feedback-item]");
  expect(feedbackItem).toHaveTextContent(FIRST_PASSAGE);
  expect(feedbackItem).not.toHaveTextContent(SECOND_PASSAGE);
});

test("Combine inline feedback with the rest of a message draft", async () => {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(FIRST_PASSAGE),
    onSend(send) {
      sends.push(send);
    },
  });
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000731",
    filename: "review-notes.txt",
    contentType: "text/plain",
    size: 5,
    url: "https://cdn.example.test/review-notes.txt",
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const user = userEvent.setup({ delay: null });

  await fillComposer(
    screen.getByRole("textbox", { name: "Message" }),
    "Please tighten the launch summary.",
  );
  const fileInput =
    document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) {
    throw new Error("Expected the composer file input");
  }
  await user.upload(
    fileInput,
    new File(["notes"], "review-notes.txt", { type: "text/plain" }),
  );
  await screen.findByText("review-notes.txt");
  await selectPassage(FIRST_PASSAGE);
  const note = await quoteSelectedPassage();
  await user.type(note, "Name each stage explicitly.");

  click(await findButton("Send"));

  const sent = await waitForSend(sends, 1);
  const parts = sent.userMessage?.parts ?? [];
  expect(parts).toContainEqual(
    expect.objectContaining({
      type: "text",
      text: "Please tighten the launch summary.",
    }),
  );
  expect(parts).toContainEqual(
    expect.objectContaining({
      type: "feedback",
      quote: FIRST_PASSAGE,
      note: [{ type: "text", text: "Name each stage explicitly." }],
    }),
  );
  expect(parts).toContainEqual(
    expect.objectContaining({
      type: "file",
      filenameSnapshot: "review-notes.txt",
    }),
  );
});
