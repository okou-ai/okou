import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  clearPassageSelection,
  completedConversation,
  context,
  feedbackItems,
  feedbackNotes,
  FIRST_CAPABILITY_RUN_ID,
  findButton,
  installCapabilityChat,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  selectAcrossPassages,
  selectPassage,
  selectPassageWithoutActions,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  findEnabledButton,
  promptEvent,
} from "./chat-run-test-fixtures.ts";
import { buttonByLabel } from "./chat-lifecycle-test-helpers.ts";

const FIRST_PASSAGE = "The launch plan has three careful stages.";
const SECOND_PASSAGE = "The unrelated answer covers a separate decision.";

function queryToolbarButton(name: string): HTMLElement | null {
  return (
    queryAllByRoleFast("button").find((button) => {
      return (
        button.getAttribute("aria-keyshortcuts") !== null &&
        button.textContent?.replace(/\s+/gu, " ").trim().startsWith(name)
      );
    }) ?? null
  );
}

function feedbackParts(document: UserMessageDocument | undefined) {
  return (
    document?.parts.filter((part) => {
      return part.type === "feedback";
    }) ?? []
  );
}

test("Offer passage actions only for a valid assistant selection", async () => {
  installCapabilityChat({
    events: completedConversation(FIRST_PASSAGE, SECOND_PASSAGE),
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const firstResponse = await screen.findByText(FIRST_PASSAGE);
  expect(firstResponse).toBeVisible();

  await selectPassage("launch plan has three careful stages");

  expect(queryToolbarButton("Copy")).toBeVisible();
  expect(queryToolbarButton("Quote")).toBeVisible();
  expect(queryToolbarButton("Forward")).toBeVisible();

  await selectAcrossPassages("launch plan", "separate decision");

  expect(queryToolbarButton("Copy")).not.toBeInTheDocument();
  expect(queryToolbarButton("Quote")).not.toBeInTheDocument();
  expect(queryToolbarButton("Forward")).not.toBeInTheDocument();

  await selectPassage("launch plan has three careful stages");
  clearPassageSelection();

  await waitFor(() => {
    expect(queryToolbarButton("Quote")).not.toBeInTheDocument();
  });

  await selectPassage("launch plan has three careful stages");
  const nativeCopyAvailable = fireEvent.keyDown(document, {
    key: "c",
    ctrlKey: true,
  });

  expect(nativeCopyAvailable).toBeTruthy();
  await waitFor(() => {
    expect(queryToolbarButton("Quote")).not.toBeInTheDocument();
  });

  await selectPassage("launch plan has three careful stages");
  fireEvent.keyDown(document, { key: "q" });

  const comment = await screen.findByRole("textbox", {
    name: "What should change about this?",
  });
  expect(comment).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  expect(feedbackItems()[0]).toHaveTextContent(
    "launch plan has three careful stages",
  );
});

test("Expand desktop passage actions to the boundary of one AI reply", async () => {
  installCapabilityChat({
    events: completedConversation(FIRST_PASSAGE, SECOND_PASSAGE),
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const firstResponse = await screen.findByText(FIRST_PASSAGE);
  const assistantReply = firstResponse.closest('[data-role="assistant"]');
  if (!assistantReply) {
    throw new Error("AI reply boundary was not rendered");
  }
  const renderedDetail = document.createElement("div");
  renderedDetail.textContent = "A rendered detail outside Markdown.";
  assistantReply.append(renderedDetail);

  await selectPassage("rendered detail outside Markdown");

  expect(queryToolbarButton("Copy")).toBeVisible();
  expect(queryToolbarButton("Quote")).toBeVisible();
  expect(queryToolbarButton("Forward")).toBeVisible();

  await selectAcrossPassages(
    "rendered detail outside Markdown",
    "separate decision",
  );

  expect(queryToolbarButton("Copy")).not.toBeInTheDocument();
  expect(queryToolbarButton("Quote")).not.toBeInTheDocument();
  expect(queryToolbarButton("Forward")).not.toBeInTheDocument();
});

test("Hide passage actions for a run summary inside an AI reply", async () => {
  installCapabilityChat({
    events: [
      promptEvent({
        id: "capability-run-summary-user",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 1,
        text: "Prepare the run summary response",
        createdAt: "2026-08-01T10:00:00.000Z",
      }),
      assistantEvent({
        id: "capability-run-summary-work",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 2,
        text: "Checked the rollout dependencies",
        createdAt: "2026-08-01T10:00:20.000Z",
      }),
      assistantEvent({
        id: "capability-run-summary-answer",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 3,
        text: FIRST_PASSAGE,
        createdAt: "2026-08-01T10:00:40.000Z",
      }),
      completedEvent({
        id: "capability-run-summary-completed",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 4,
        createdAt: "2026-08-01T10:01:00.000Z",
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(screen.findByText("Worked for 1m")).resolves.toBeVisible();
  await selectPassage("launch plan has three careful stages");
  await selectPassageWithoutActions("Worked for 1m");

  expect(queryToolbarButton("Copy")).not.toBeInTheDocument();
  expect(queryToolbarButton("Quote")).not.toBeInTheDocument();
  expect(queryToolbarButton("Forward")).not.toBeInTheDocument();
});

test("Keep touch passage actions within the Markdown boundary", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)";
  });
  installCapabilityChat({
    events: completedConversation(FIRST_PASSAGE),
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const firstResponse = await screen.findByText(FIRST_PASSAGE);
  const assistantReply = firstResponse.closest('[data-role="assistant"]');
  if (!assistantReply) {
    throw new Error("AI reply boundary was not rendered");
  }
  const renderedDetail = document.createElement("div");
  renderedDetail.textContent = "A touch-only detail outside Markdown.";
  assistantReply.append(renderedDetail);

  await selectPassage("launch plan has three careful stages");
  await selectPassageWithoutActions("touch-only detail outside Markdown");

  expect(queryToolbarButton("Copy")).not.toBeInTheDocument();
  expect(queryToolbarButton("Quote")).not.toBeInTheDocument();
  expect(queryToolbarButton("Forward")).not.toBeInTheDocument();
});

test("Combine inline feedback with the rest of a message draft", async () => {
  const sends: CapturedChatSend[] = [];
  const file = new File(["review evidence"], "review-notes.txt", {
    type: "text/plain",
  });
  context.mocks.upload.success({
    id: "feedback-review-notes",
    filename: file.name,
    contentType: file.type,
    size: file.size,
    url: "https://cdn.vm7.io/feedback/review-notes.txt",
  });
  installCapabilityChat({
    events: completedConversation(FIRST_PASSAGE),
    onSend(send) {
      sends.push(send);
    },
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  const user = userEvent.setup({ delay: null });
  await user.click(composer);
  await user.type(composer, "Keep the rollout concise.");
  await selectPassage("launch plan has three careful stages");
  const comment = await quoteSelectedPassage();
  await user.type(comment, "Explain why each stage matters.");

  expect(composer).toHaveTextContent("Keep the rollout concise.");
  expect(feedbackItems()[0]).toHaveTextContent(
    "launch plan has three careful stages",
  );
  expect(comment).toHaveTextContent("Explain why each stage matters.");

  const fileInput = document.querySelector<HTMLInputElement>(
    '[data-chat-composer] input[type="file"]',
  );
  if (!fileInput) {
    throw new Error("Composer file input was not available");
  }
  await userEvent.setup().upload(fileInput, file);
  const uploadedFile = await screen.findByText("review-notes.txt");
  expect(uploadedFile).toBeVisible();

  click(await findButton("Send"));

  const sent = await waitForSend(sends, 1);
  expect(sent.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      { type: "text", text: "Keep the rollout concise." },
      expect.objectContaining({
        type: "feedback",
        quote: "launch plan has three careful stages",
        note: [{ type: "text", text: "Explain why each stage matters." }],
      }),
      {
        type: "file",
        fileId: "feedback-review-notes",
        filenameSnapshot: "review-notes.txt",
        contentType: "text/plain",
      },
    ]),
  );
});

test("Edit or remove a quoted feedback item", async () => {
  installCapabilityChat({ events: completedConversation(FIRST_PASSAGE) });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  const user = userEvent.setup({ delay: null });
  await user.click(composer);
  await user.type(composer, "Keep this ordinary draft text.");
  await selectPassage("launch plan has three careful stages");
  let comment = await quoteSelectedPassage();

  expect(comment).toHaveAccessibleName("What should change about this?");
  await user.type(comment, "Make the stages shorter.");
  expect(comment).toHaveTextContent("Make the stages shorter.");

  await user.keyboard("{Backspace}".repeat("Make the stages shorter.".length));
  comment = screen.getByRole("textbox", {
    name: "What should change about this?",
  });
  expect(comment).not.toHaveTextContent("Make the stages shorter.");
  expect(feedbackItems()[0]).toHaveTextContent(
    "launch plan has three careful stages",
  );

  await user.type(comment, "Show the owner for every stage.");
  expect(comment).toHaveTextContent("Show the owner for every stage.");

  click(await findButton("Remove feedback"));

  await waitFor(() => {
    expect(feedbackItems()).toHaveLength(0);
  });
  expect(composer).toHaveTextContent("Keep this ordinary draft text.");
});

async function openMultipleQuoteFeedback() {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(`${FIRST_PASSAGE}\n\n${SECOND_PASSAGE}`),
    onSend(send) {
      sends.push(send);
    },
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  return sends;
}

test("Edit and send independent notes on multiple quoted passages", async () => {
  const user = userEvent.setup({ delay: null });
  const sends = await openMultipleQuoteFeedback();
  await selectPassage("launch plan has three careful stages");
  await user.type(await quoteSelectedPassage(), "Add an owner to this stage.");
  await selectPassage("unrelated answer covers a separate decision");
  await quoteSelectedPassage();
  const notes = feedbackNotes();

  expect(notes).toHaveLength(2);
  expect(notes[0]).toHaveTextContent("Add an owner to this stage.");
  await user.type(notes[1]!, "Temporary second comment.");
  await user.keyboard("{Backspace}".repeat("Temporary second comment.".length));
  await user.type(notes[1]!, "Acknowledge the separate decision.");
  expect(notes[0]).toHaveTextContent("Add an owner to this stage.");

  await findEnabledButton("Send");
  click(buttonByLabel("Send"));

  const commented = await waitForSend(sends, 1);
  expect(feedbackParts(commented.userMessage)).toMatchObject([
    {
      quote: "launch plan has three careful stages",
      note: [{ type: "text", text: "Add an owner to this stage." }],
    },
    {
      quote: "unrelated answer covers a separate decision",
      note: [{ type: "text", text: "Acknowledge the separate decision." }],
    },
  ]);

  await expect(findEnabledButton("Stop")).resolves.toBeVisible();
  expect(feedbackItems()).toHaveLength(0);
});

test("Quoting passages again clears comments from the previous feedback message", async () => {
  const user = userEvent.setup({ delay: null });
  const sends = await openMultipleQuoteFeedback();
  await selectPassage("launch plan has three careful stages");
  await user.type(await quoteSelectedPassage(), "Add an owner to this stage.");
  await selectPassage("unrelated answer covers a separate decision");
  await user.type(
    await quoteSelectedPassage(),
    "Acknowledge the separate decision.",
  );
  await findEnabledButton("Send");
  click(buttonByLabel("Send"));
  const commented = await waitForSend(sends, 1);
  expect(feedbackParts(commented.userMessage)).toMatchObject([
    {
      quote: "launch plan has three careful stages",
      note: [{ type: "text", text: "Add an owner to this stage." }],
    },
    {
      quote: "unrelated answer covers a separate decision",
      note: [{ type: "text", text: "Acknowledge the separate decision." }],
    },
  ]);
  await expect(findEnabledButton("Stop")).resolves.toBeVisible();
  expect(feedbackItems()).toHaveLength(0);

  await selectPassage("launch plan has three careful stages");
  await quoteSelectedPassage();
  await selectPassage("unrelated answer covers a separate decision");
  await quoteSelectedPassage();
  const notes = feedbackNotes();
  expect(notes).toHaveLength(2);
  expect(notes[0]).not.toHaveTextContent("Add an owner to this stage.");
  expect(notes[1]).not.toHaveTextContent("Acknowledge the separate decision.");

  // The action can replace its button while waitFor drains pending renders.
  // Resolve the current button after readiness instead of clicking that old node.
  await findEnabledButton("Send");
  click(buttonByLabel("Send"));

  const uncommented = await waitForSend(sends, 2);
  expect(feedbackParts(uncommented.userMessage)).toMatchObject([
    {
      quote: "launch plan has three careful stages",
      note: [],
    },
    {
      quote: "unrelated answer covers a separate decision",
      note: [],
    },
  ]);
  await waitFor(() => {
    const feedbackGroups = document.querySelectorAll<HTMLElement>(
      "[data-structured-feedback-group]",
    );
    expect(feedbackGroups).toHaveLength(2);
    const currentGroup = feedbackGroups.item(1);
    expect(currentGroup).toBeVisible();

    const quotes = currentGroup.querySelectorAll<HTMLElement>(
      "[data-structured-feedback-quote]",
    );
    expect(quotes).toHaveLength(2);
    expect(quotes.item(0)).toHaveTextContent(
      "launch plan has three careful stages",
    );
    expect(quotes.item(1)).toHaveTextContent(
      "unrelated answer covers a separate decision",
    );
  });
});
