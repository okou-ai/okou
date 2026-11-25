import { test, expect } from "vitest";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  boxAnnotation,
  draftAttachment,
  draftForAttachment,
  ATTACHMENT_THREAD_ID,
  mockAttachmentChat,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";
import { conversation } from "./attachment-preview-boundaries.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import {
  continuityAttachment,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

const context = testContext();

test("chat-attachment-composer-001 pasted notes and dropped PDF are independently removable", async () => {
  const text = new File(["Field notes"], "field-notes.txt", {
      type: "text/plain",
    }),
    pdf = new File(["%PDF-1.5"], "briefing.pdf", { type: "application/pdf" });
  await conversation(context, {});
  const editor = await findComposerEditor();
  editor.focus();
  context.mocks.upload.success({
    id: crypto.randomUUID(),
    filename: text.name,
    contentType: text.type,
    size: text.size,
    url: "https://cdn.okou.io/artifacts/field/files/note.txt",
  });
  const transfer = new DataTransfer();
  transfer.setData("text/plain", "Review my field notes");
  transfer.items.add(text);
  fireEvent.paste(editor, { clipboardData: transfer });
  await waitFor(() => {
    return expect(editor).toHaveTextContent("Review my field notes");
  });
  await expect(
    findAction("button", "Remove " + text.name),
  ).resolves.toBeVisible();
  context.mocks.upload.success({
    id: crypto.randomUUID(),
    filename: pdf.name,
    contentType: pdf.type,
    size: pdf.size,
    url: "https://cdn.okou.io/artifacts/field/files/briefing.pdf",
  });
  const drop = new DataTransfer();
  drop.items.add(pdf);
  fireEvent.dragOver(editor, { dataTransfer: drop });
  fireEvent.drop(editor, { dataTransfer: drop });
  await expect(
    findAction("button", "Remove " + pdf.name),
  ).resolves.toBeVisible();
  await expect(
    findAction("button", "Remove " + text.name),
  ).resolves.toBeVisible();
});

function markedDraft(filename: string, note: string) {
  const image = draftAttachment(filename, {
    id: crypto.randomUUID(),
    annotatedFileId: crypto.randomUUID(),
    annotations: boxAnnotation([{ id: crypto.randomUUID(), ordinal: 1, note }]),
  });
  return { image, draft: draftForAttachment(image) };
}

test("chat-attachment-composer-003 the dispatched billing instruction carries the saved structured annotation", async () => {
  const { image, draft } = markedDraft(
    "billing-page.png",
    "Tighten this spacing.",
  );
  const sent: unknown[] = [];
  await conversation(context, {
    draft,
    onSendRequest: (body) => {
      sent.push(body);
    },
  });
  await screen.findByTestId("composer-attachment-mark-count");
  await fill(await findComposerEditor(), "Fix the billing page");
  click(await findAction("button", "Send"));
  await waitFor(() => {
    return expect(sent).toContainEqual(
      expect.objectContaining({
        prompt: "Fix the billing page",
        userMessage: expect.objectContaining({
          parts: expect.arrayContaining([
            {
              type: "file",
              fileId: image.id,
              filenameSnapshot: image.filename,
              contentType: "image/png",
              annotatedFileId: image.annotatedFileId,
              annotations: image.annotations,
            },
          ]),
        }),
      }),
    );
  });
});

test("chat-attachment-composer-006 the restored mark opens on its saved image", async () => {
  const { image, draft } = markedDraft("saved-layout.png", "Align the margin.");
  await conversation(context, { draft });
  await expect(
    screen.findByTestId("composer-attachment-mark-count"),
  ).resolves.toHaveTextContent("1");
  click(await findAction("button", "Open image preview for " + image.filename));
  const dialog = await screen.findByTestId("attachment-lightbox");
  const layer = await within(dialog).findByTestId("annotation-mark-layer");
  expect(within(layer).getByText("1")).toBeVisible();
  expect(layer).toHaveTextContent("1");
});

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

test("Recover saved draft attachments safely", async () => {
  const fileId = "e0000000-0000-4000-a000-000000000da1";
  const resolvedUrl = "https://files.example.test/uploads/brief-cover.png";
  mockAttachmentChat(context, {
    draft: draftForAttachment(
      draftAttachment("brief-cover.png", {
        id: fileId,
        url: privateAttachmentUrl(fileId),
      }),
      "Review the available brief",
    ),
  });
  // The saved upload still resolves, so the attachment is available.
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    expect(query.file_id).toBe(fileId);
    return respond(200, {
      url: resolvedUrl,
      downloadUrl: `${resolvedUrl}?download=1`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
    });
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await expect(findComposerEditor()).resolves.toHaveTextContent(
    "Review the available brief",
  );
  const preview = await waitFor(() => {
    const button = queryAllByRoleFast("button").find((candidate) => {
      return (
        candidate.getAttribute("aria-label") ===
        "Open image preview for brief-cover.png"
      );
    });
    expect(button?.querySelector("img")).toHaveAttribute("src", resolvedUrl);
    return button;
  });
  expect(preview).toBeEnabled();
  expect(screen.queryByText(/is no longer available/u)).not.toBeInTheDocument();
});
