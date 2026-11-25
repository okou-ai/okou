import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage, fill, click } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  RUN_THREAD_ID,
  RUN_PATH,
  createChatRunFixtures,
  findButton,
  findEnabledButton,
} from "./chat-run-test-fixtures.ts";
import {
  completedConversation,
  feedbackItems,
  selectPassage,
  clearPassageSelection,
} from "./chat-capability-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { type UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import {
  continuityAttachment,
  continuityDraft,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

const passage = "The launch plan has three careful stages.";

async function conversation() {
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: completedConversation(passage),
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText(passage);
}

test("chat-selection-actions-001 quoting after a rename preserves the unfinished draft", async () => {
  await conversation();
  const editor = await findComposerEditor();
  await fill(editor, "Keep this outline");
  editor.focus();
  await userEvent.keyboard("{F2}");
  const form = await screen.findByRole("dialog");
  const title = within(form).getByRole("textbox");
  await fill(title, "Launch review");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(
      screen.getAllByText("Launch review", { exact: true }).some((element) => {
        return element.closest("nav") === null;
      }),
    ).toBeTruthy();
  });
  await selectPassage(passage);
  click(await findButton("Quote"));
  await screen.findByRole("textbox", { name: "Ask or comment on this quote" });
  expect(editor).toHaveTextContent("Keep this outline");
  expect(feedbackItems()).toHaveLength(1);
  expect(feedbackItems()[0]).toHaveTextContent(passage);
});

async function releaseSelection(name: string) {
  await selectPassage(passage);
  const action = await findButton(name);
  fireEvent.pointerDown(action, {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    pointerType: "mouse",
  });
  clearPassageSelection();
  fireEvent.pointerUp(action, {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    pointerType: "mouse",
  });
  click(action);
}

test("chat-selection-actions-002 Copy keeps the selected passage through native selection collapse", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await conversation();
  await releaseSelection("Copy");
  await screen.findByText("Copied");
  expect(clipboard.writes).toContain(passage);
  expect(document.querySelector("[aria-keyshortcuts=q]")).toBeNull();
});

test("chat-selection-actions-004 Fork carries the original passage after pointer release clears selection", async () => {
  await conversation();
  await releaseSelection("Fork");
  const dialog = await screen.findByRole("dialog", { name: "Okou" });
  expect(within(dialog).getByText(passage)).toBeInTheDocument();
  expect(document.querySelector("[aria-keyshortcuts=q]")).toBeNull();
});

test("chat-composer-feedback-selection-001 ArrowDown at the end keeps the next character in the quote note", async () => {
  const passage = "The launch plan has three careful stages.",
    comment = "Keep this review in the quote.";
  const sent = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    chatEvents: completedConversation(passage),
    onSendRequest(body) {
      sent.resolve(body.userMessage);
    },
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await screen.findByText(passage);
  await selectPassage(passage);
  click(await findButton("Quote"));
  const editor = await screen.findByRole("textbox", {
    name: "Ask or comment on this quote",
  });
  const user = userEvent.setup({ delay: null });
  await user.type(editor, comment);
  await user.keyboard("{ArrowDown}");
  const caret = window.getSelection();
  expect(caret?.isCollapsed).toBeTruthy();
  expect(editor.contains(caret?.focusNode ?? null)).toBeTruthy();
  expect(caret?.focusNode?.textContent).toBe(comment);
  expect(caret?.focusOffset).toBe(comment.length);
  await user.keyboard("!");
  expect(editor).toHaveTextContent(comment + "!");
  click(await findEnabledButton("Send"));
  expect((await sent.promise)?.parts).toContainEqual(
    expect.objectContaining({
      type: "feedback",
      quote: passage,
      note: [{ type: "text", text: comment + "!" }],
    }),
  );
});

test("user-message-document-007 Copying the sent PDF preserves its saved attachment and empty prompt representation", async () => {
  const clipboard = context.mocks.browser.clipboardWrite();
  const pdf = continuityAttachment(
    791,
    1,
    "lighting-plan.pdf",
    "application/pdf",
  );
  const chat = continuityThread(791, 1, "Lighting brief");
  const part = {
    type: "file",
    fileId: pdf.id,
    filenameSnapshot: pdf.filename,
    contentType: pdf.contentType,
  } as const;
  const sent = context.mocks.deferred<unknown>();
  mockChatLifecycle(context, {
    threadId: chat.id,
    onSendRequest: (b) => {
      return sent.resolve(b);
    },
  });
  const workspace = installContinuityWorkspace(context, {
    caseId: 791,
    threads: [chat],
    drafts: new Map([[chat.id, continuityDraft([part], [pdf])]]),
  });
  await setupPage({
    context,
    path: "/chats/" + chat.id,
    ...workspace.pageOptions,
  });
  await expect(
    findEnabledButton("Remove lighting-plan.pdf"),
  ).resolves.toBeVisible();
  click(await findEnabledButton("Send"));
  await expect(sent.promise).resolves.toMatchObject({
    userMessage: { parts: expect.arrayContaining([part]) },
  });
  click(await findEnabledButton("Copy message"));
  const item = await waitFor(() => {
    const value = clipboard.writes.at(-1)?.[0];
    if (!value) {
      throw new Error("The page has not written the message to the clipboard");
    }
    return value;
  });
  const html = await (await item.getType("text/html")).text();
  const encoded = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector<HTMLElement>("[data-okou-chat-message]")
    ?.dataset.okouChatMessage;
  expect(JSON.parse(decodeURIComponent(encoded ?? ""))).toMatchObject({
    text: "",
    attachments: [
      expect.objectContaining({ id: pdf.id, filename: pdf.filename }),
    ],
    userMessage: { parts: expect.arrayContaining([part]) },
  });
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeVisible();
});
