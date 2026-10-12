import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  button,
  chooseCommand,
  setupModels,
} from "./chat-composer-create-test-helpers.ts";
import {
  THREAD_ID,
  context,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import {
  readClipboardItemText,
  readSingleRichClipboardWrite,
} from "./chat-lifecycle-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

test("Persisted additional info stays out of the message and copied text", async () => {
  setupModels();
  const clipboard = context.mocks.browser.clipboardWrite();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        role: "user",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "additional_info",
              text: "Create a presentation.\nAdditional generation settings.",
            },
            { type: "text", text: "Our launch brief" },
          ],
        },
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });
  const text = await screen.findByText("Our launch brief");
  const message = text.closest<HTMLElement>('[data-role="user"]');
  if (!message) {
    throw new Error("Expected the user message");
  }
  expect(message).toBeVisible();
  expect(message).not.toHaveTextContent("Create");
  expect(message).not.toHaveTextContent("Additional generation settings");
  click(button("Copy message", message));
  const item = await readSingleRichClipboardWrite(clipboard);
  await expect(readClipboardItemText(item, "text/plain")).resolves.toBe(
    "Our launch brief",
  );
});

async function setupQueuedCreateConversation(): Promise<UserMessageDocument[]> {
  setupModels();
  const queued: UserMessageDocument[] = [];
  const runId = crypto.randomUUID();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    activeRunIds: [runId],
    chatEvents: [
      {
        role: "user",
        content: "Review the launch brief",
        runId,
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
    onQueuedEventAppend: (body) => {
      if (body.userMessage) {
        queued.push(body.userMessage);
      }
    },
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });
  await screen.findByText("Review the launch brief");
  return queued;
}

async function chooseSlideCount(name: "20–24 slides" | "4–8 slides") {
  click(screen.getByRole("combobox", { name: "Slide count" }));
  click(await screen.findByRole("option", { name }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Slide count" }),
    ).toHaveTextContent(name);
  });
}

test("A queued Create message keeps its intent separate from user-authored text", async () => {
  const queued = await setupQueuedCreateConversation();
  const followupEditor = await findComposerEditor();
  const prompt = "Create a presentation. Keep these words in my message.";
  await chooseCommand(followupEditor, `${prompt} /`, "presentation");
  await chooseSlideCount("20–24 slides");
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(queued).toHaveLength(1);
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create a presentation."),
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 20-24"),
  });
  expect(
    queued[0]?.parts
      .filter((part) => {
        return part.type === "text";
      })
      .map((part) => {
        return part.text;
      })
      .join("")
      .trim(),
  ).toBe(prompt);
  await expect(screen.findByText(prompt)).resolves.toBeVisible();
});
