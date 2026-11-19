import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  chatThreadByIdContract,
  type ComposerDraft,
} from "@okouai/api-contracts/contracts/chat-threads";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityAttachment,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();

interface ClipboardAttachment {
  readonly id: string | null;
  readonly url: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
}

interface RichClipboardPayload {
  readonly text: string;
  readonly attachments: readonly ClipboardAttachment[];
  readonly userMessage?: {
    readonly version: 1;
    readonly parts: readonly (
      | { readonly type: "text"; readonly text: string }
      | {
          readonly type: "chat_thread";
          readonly threadId: string;
          readonly titleSnapshot: string;
        }
    )[];
  };
}

function richClipboard(
  payload: RichClipboardPayload,
  plainText = payload.text,
): DataTransfer {
  const data = new DataTransfer();
  const encoded = encodeURIComponent(JSON.stringify(payload));
  data.setData(
    "text/html",
    `<div data-okou-chat-message="${encoded}">${payload.text}</div>`,
  );
  data.setData("text/plain", plainText);
  return data;
}

function placeCaret(
  composer: HTMLElement,
  textNodeContent: string,
  offset: number,
): void {
  const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.textContent !== textNodeContent) {
    node = walker.nextNode();
  }
  if (!node) {
    throw new Error(`Expected composer text node ${textNodeContent}`);
  }
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  composer.focus();
}

function composerLines(composer: HTMLElement): string[] {
  return [...composer.querySelectorAll("p")]
    .map((paragraph) => {
      return paragraph.textContent?.trim() ?? "";
    })
    .filter(Boolean);
}

function placeCaretAtEnd(composer: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  composer.focus();
}

test("Pasted chat content keeps its lines and reports an inaccessible attachment", async () => {
  const thread = continuityThread(14, 1, "Clipboard restoration");
  const available = continuityAttachment(14, 1, "available-copy.txt");
  const missing = continuityAttachment(14, 2, "missing-copy.txt");
  const workspace = installContinuityWorkspace(context, {
    caseId: 14,
    threads: [thread],
    resolveAttachment(fileId) {
      return fileId === missing.id ? "missing" : "available";
    },
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await userEvent.type(composer, "Before after");
  placeCaret(composer, "Before after", 7);
  fireEvent.paste(composer, {
    clipboardData: richClipboard({
      text: "First copied line\nSecond copied line",
      attachments: [available],
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "First copied line\nSecond copied line" },
        ],
      },
    }),
  });

  await waitFor(() => {
    expect(composer).toHaveTextContent("First copied line");
    expect(composer).toHaveTextContent("Second copied line");
    expect(fastButton("Remove available-copy.txt")).toBeVisible();
  });
  expect(composerLines(composer)).toStrictEqual([
    "Before",
    "First copied line",
    "Second copied line",
    "after",
  ]);

  placeCaretAtEnd(composer);
  fireEvent.paste(composer, {
    clipboardData: richClipboard({
      text: " Text kept from an inaccessible copy",
      attachments: [missing],
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: " Text kept from an inaccessible copy" }],
      },
    }),
  });
  await expect(
    screen.findByText(
      "missing-copy.txt is no longer available. Upload it again to send.",
    ),
  ).resolves.toBeVisible();
  expect(composer).toHaveTextContent("Text kept from an inaccessible copy");
  expect(fastButton("Remove available-copy.txt")).toBeVisible();
});

test("Pasted text and a resolving attachment are saved once the file is available", async () => {
  const thread = continuityThread(19, 1, "Persist clipboard attachments");
  const attachment = continuityAttachment(19, 1, "copied-notes.txt");
  const resolutionStarted = context.mocks.deferred<void>();
  const resolveFile = context.mocks.deferred<void>();
  const saved = context.mocks.deferred<{
    draftUserMessage: ComposerDraft["draftUserMessage"];
    draftAttachments?: ComposerDraft["draftAttachments"];
  }>();
  const workspace = installContinuityWorkspace(context, {
    caseId: 19,
    threads: [thread],
    async resolveAttachment(): Promise<"available" | "missing"> {
      resolutionStarted.resolve();
      await resolveFile.promise;
      return "available";
    },
  });
  context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
    if (
      body.draftAttachments?.some((file) => {
        return file.id === attachment.id;
      })
    ) {
      saved.resolve(body);
    }
    return respond(204);
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  fireEvent.paste(composer, {
    clipboardData: richClipboard({
      text: "Copied notes to keep",
      attachments: [attachment],
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Copied notes to keep" }],
      },
    }),
  });
  await resolutionStarted.promise;
  expect(composer).toHaveTextContent("Copied notes to keep");
  expect(fastButton("Cancel upload copied-notes.txt")).toBeVisible();
  resolveFile.resolve();
  const savedDraft = await saved.promise;
  expect(savedDraft.draftUserMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      { type: "text", text: "Copied notes to keep" },
      expect.objectContaining({ type: "file", fileId: attachment.id }),
    ]),
  );
  await expect(screen.findByLabelText("Send")).resolves.toBeEnabled();
});

test("Pasted text and a chat reference land at the draft cursor in order", async () => {
  const thread = continuityThread(15, 1, "Paste position");
  const referenced = continuityThread(15, 2, "Launch reference");
  const workspace = installContinuityWorkspace(context, {
    caseId: 15,
    threads: [thread, referenced],
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await userEvent.type(composer, "Alpha omega");
  placeCaret(composer, "Alpha omega", 6);
  await userEvent.paste("middle ");
  await waitFor(() => {
    expect(composer).toHaveTextContent("Alpha middle omega");
  });

  placeCaretAtEnd(composer);
  fireEvent.paste(composer, {
    clipboardData: richClipboard({
      text:
        `\nFirst pasted line\n[Launch reference](/chats/${referenced.id})` +
        "\nLast pasted line",
      attachments: [],
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "\nFirst pasted line\n" },
          {
            type: "chat_thread",
            threadId: referenced.id,
            titleSnapshot: "Launch reference",
          },
          { type: "text", text: "\nLast pasted line" },
        ],
      },
    }),
  });

  await waitFor(() => {
    expect(composer).toHaveTextContent("Alpha middle omega");
    expect(composer).toHaveTextContent("First pasted line");
    expect(composer).toHaveTextContent("Launch reference");
    expect(composer).toHaveTextContent("Last pasted line");
  });
  const reference = composer.querySelector<HTMLElement>(
    `[data-chat-thread-mention="${referenced.id}"]`,
  );
  expect(reference).toBeVisible();
  const finalText = composer.textContent ?? "";
  expect(finalText.indexOf("First pasted line")).toBeLessThan(
    finalText.indexOf("Launch reference"),
  );
  expect(finalText.indexOf("Launch reference")).toBeLessThan(
    finalText.indexOf("Last pasted line"),
  );
});
