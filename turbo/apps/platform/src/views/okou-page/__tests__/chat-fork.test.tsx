import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  FIRST_CAPABILITY_RUN_ID,
  completedConversation,
  createChatCapabilityHelpers,
  selectPassage,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  chatListThread,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";

const context = testContext();

const passage = "launch plan has three careful stages";
async function startFork() {
  const sent = context.mocks.deferred<CapturedChatSend>();
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation(passage, "Unrelated revision feedback"),
    onSend: sent.resolve,
  });
  await setupPage({ context, path: RUN_PATH });
  const original = await findComposerEditor();
  await fill(original, "Unfinished source notes");
  await screen.findByText(passage);
  await selectPassage(passage);
  return { sent, original };
}

test("chat-fork-004 F opens a new draft with the highlighted source passage", async () => {
  await startFork();
  await userEvent.keyboard("f");
  const dialog = await screen.findByRole("dialog");
  const editor = await within(dialog).findByRole("textbox", {
    name: "Message",
  });
  expect(dialog).toHaveTextContent(passage);
  await fill(editor, "Focus on the launch risks.");
  expect(editor).toHaveTextContent("Focus on the launch risks.");
});
test("chat-fork-006 a fork sends only the selected feedback and its source run to the new conversation", async () => {
  const { sent, original } = await startFork();
  click(await findFastControl("button", /^Fork/i));
  const dialog = await screen.findByRole("dialog");
  const editor = await within(dialog).findByRole("textbox", {
    name: "Message",
  });
  const note = editor.querySelector<HTMLElement>(
    "[data-feedback-note] p:last-child",
  );
  if (!note) {
    throw new Error("The fork note has no editable paragraph");
  }
  await userEvent.click(note);
  const range = document.createRange();
  range.selectNodeContents(note);
  range.collapse(false);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  await userEvent.keyboard("Explore the risks in a separate conversation.");
  click(await findFastControl("button", "Send", dialog));
  const body = await sent.promise;
  expect(body.sourceRunId).toBe(FIRST_CAPABILITY_RUN_ID);
  const destination = body.threadId ?? body.clientThreadId;
  expect(destination).toStrictEqual(expect.any(String));
  expect(destination).not.toBe(RUN_THREAD_ID);
  expect(body.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "feedback",
        quote: passage,
        note: expect.arrayContaining([
          {
            type: "text",
            text: "Explore the risks in a separate conversation.",
          },
        ]),
      }),
    ]),
  );
  expect(JSON.stringify(body.userMessage)).toContain(passage);
  expect(JSON.stringify(body.userMessage)).not.toContain(
    "Unrelated revision feedback",
  );
  expect(original).toHaveTextContent("Unfinished source notes");
});

test("chat-fork-001 forking into Launch keeps the original project and draft in view", async () => {
  const project = {
    id: "af000000-0000-4000-a000-000000078102",
    name: "Launch",
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
  };
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation(passage),
  });
  const source = {
    ...chatListThread(780, "Source launch plan"),
    projectId: project.id,
    id: RUN_THREAD_ID,
  };
  installChatListStream(context, { caseId: 780, snapshot: [source] });
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [project],
      latestEventId: null,
      latestSeqId: 0,
    });
  });
  const created = context.mocks.deferred<unknown>();
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    created.resolve(body);
    return respond(201, {
      id: body.clientThreadId!,
      projectId: body.projectId,
      title: null,
      createdAt: "2026-09-01T12:00:00Z",
      selectedModel: null,
      serviceTier: null,
    });
  });
  await setupPage({ context, path: RUN_PATH });
  const original = await findComposerEditor();
  await fill(original, "Keep my launch notes");
  await screen.findByText(passage);
  await selectPassage(passage);
  await userEvent.keyboard("f");
  const dialog = await screen.findByRole("dialog");
  const editor = await within(dialog).findByRole("textbox", {
    name: "Message",
  });
  click(editor);
  await userEvent.keyboard("Explore another launch plan.");
  click(await findFastControl("button", "Send", dialog));
  await expect(created.promise).resolves.toMatchObject({
    projectId: project.id,
  });
  await screen.findByText("New chat created");
  expect(location.pathname).toBe(RUN_PATH);
  expect(original).toHaveTextContent("Keep my launch notes");
  await expect(screen.findByText("Launch")).resolves.toBeInTheDocument();
  const group = document.querySelector(
    '[data-project-children-id="' + project.id + '"]',
  );
  expect(group?.querySelector('a[href="' + RUN_PATH + '"]')).toHaveTextContent(
    "Source launch plan",
  );
});
