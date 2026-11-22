import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  continuityAttachment,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

function caret(root: HTMLElement, node: Node, offset: number) {
  root.focus();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

const context = testContext();

function paste(
  editor: HTMLElement,
  text: string,
  attachments: ReturnType<typeof continuityAttachment>[] = [],
) {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  if (attachments.length) {
    const node = document.createElement("span");
    node.dataset.okouChatMessage = encodeURIComponent(
      JSON.stringify({ text, attachments }),
    );
    node.textContent = text;
    data.setData("text/html", node.outerHTML);
  }
  fireEvent.paste(editor, { clipboardData: data });
}
test("chat-continuity-clipboard-001 pastes text at the caret and retains the available file when the next file is missing", async () => {
  const thread = continuityThread(765, 1, "Clipboard");
  const available = continuityAttachment(765, 1, "revenue.txt"),
    missing = continuityAttachment(765, 2, "obsolete.txt");
  const w = installContinuityWorkspace(context, {
    caseId: 765,
    threads: [thread],
    resolveAttachment: (id) => {
      return id === available.id ? "available" : "missing";
    },
  });
  await setupPage({ context, path: "/chats/" + thread.id, ...w.pageOptions });
  const editor = await findComposerEditor();
  await userEvent.click(editor);
  await fill(editor, "Before after");
  const text = editor.querySelector("p")!.firstChild!;
  caret(editor, text, 7);
  paste(editor, "First line\nSecond line", [available]);
  await findFastControl("button", "Remove revenue.txt");
  expect(editor.innerHTML).toMatch(
    /Before .*First line.*(?:<br|<\/p>).*Second line.*after/s,
  );
  paste(editor, "Later note", [missing]);
  await screen.findByText(
    "obsolete.txt is no longer available. Upload it again to send.",
  );
  expect(editor).toHaveTextContent("Later note");
  await expect(
    findFastControl("button", "Remove revenue.txt"),
  ).resolves.toBeEnabled();
});
test("chat-continuity-clipboard-002 resolving a pasted file changes it from cancellable to a saved sendable draft", async () => {
  const thread = continuityThread(766, 1, "Copied notes"),
    file = continuityAttachment(766, 1, "notes.txt");
  const pending = context.mocks.deferred<"available">();
  const w = installContinuityWorkspace(context, {
    caseId: 766,
    threads: [thread],
    resolveAttachment: () => {
      return pending.promise;
    },
  });
  await setupPage({ context, path: "/chats/" + thread.id, ...w.pageOptions });
  const editor = await findComposerEditor();
  click(editor);
  paste(editor, "Copied notes to keep", [file]);
  expect(editor).toHaveTextContent("Copied notes to keep");
  await findFastControl("button", "Cancel upload notes.txt");
  pending.resolve("available");
  await findFastControl("button", "Remove notes.txt");
  await waitFor(() => {
    return expect(w.draftPatches.at(-1)).toMatchObject({
      threadId: thread.id,
      draftAttachments: [{ id: file.id }],
      draftUserMessage: {
        parts: expect.arrayContaining([
          expect.objectContaining({ text: "Copied notes to keep" }),
        ]),
      },
    });
  });
  await expect(findFastControl("button", "Send")).resolves.toBeEnabled();
});
test("chat-continuity-clipboard-004 plain text and a linked conversation are inserted in reading order", async () => {
  const thread = continuityThread(767, 1, "Working draft"),
    ref = continuityThread(767, 2, "Source chat");
  const w = installContinuityWorkspace(context, {
    caseId: 767,
    threads: [thread, ref],
  });
  await setupPage({ context, path: "/chats/" + thread.id, ...w.pageOptions });
  const editor = await findComposerEditor();
  await userEvent.click(editor);
  await fill(editor, "Alpha omega");
  const text = editor.querySelector("p")!.firstChild!;
  caret(editor, text, 6);
  paste(editor, "middle ");
  expect(editor).toHaveTextContent(/^Alpha middle omega$/);
  {
    const last = editor.querySelector("p")!.lastChild!;
    caret(editor, last, last.textContent!.length);
  }
  const transfer = new DataTransfer();
  const html = document.createElement("span");
  const referenceText = "First line\nSource chat\nLast line";
  html.dataset.okouChatMessage = encodeURIComponent(
    JSON.stringify({
      text: referenceText,
      attachments: [],
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "First line\n" },
          {
            type: "chat_thread",
            threadId: ref.id,
            titleSnapshot: "Source chat",
          },
          { type: "text", text: "\nLast line" },
        ],
      },
    }),
  );
  transfer.setData("text/html", html.outerHTML);
  transfer.setData("text/plain", referenceText);
  fireEvent.paste(editor, { clipboardData: transfer });
  await waitFor(() => {
    return expect(editor.textContent).toMatch(
      /First line.*Source chat.*Last line/s,
    );
  });
  expect(
    editor.querySelector(
      "[data-chat-thread-id], [data-type=chatThread], [data-chat-thread-reference], [contenteditable=false]",
    ),
  ).toHaveTextContent("Source chat");
});
