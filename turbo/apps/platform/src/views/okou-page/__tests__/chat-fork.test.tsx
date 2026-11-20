import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  CAPABILITY_AGENT_ID,
  completedConversation,
  createChatCapabilityHelpers,
  FIRST_CAPABILITY_RUN_ID,
  RUN_PATH,
  RUN_THREAD_ID,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";
import { continuityThread } from "./chat-continuity-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
const PASSAGE = "launch plan has three careful stages";
const PROJECT_ID = "30000000-0000-4000-8000-000000000071";

function installProjectConversation(projectId: string | null) {
  installCapabilityChat({
    events: completedConversation(`The ${PASSAGE}.`),
  });
  const source = {
    ...continuityThread(331, 1, "Launch planning"),
    id: RUN_THREAD_ID,
    agentId: CAPABILITY_AGENT_ID,
    projectId,
  };
  const threads = [source];
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: threads,
        latestEventId: RUN_THREAD_ID,
        latestSeqId: 1,
      }),
    );
  });
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [
        {
          id: PROJECT_ID,
          name: "Launch",
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
        },
      ],
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    const thread = {
      ...source,
      id: body.clientThreadId ?? crypto.randomUUID(),
      title: null,
      projectId: body.projectId ?? null,
    };
    threads.push(thread);
    return respond(201, {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt,
      selectedModel: body.model ?? null,
      serviceTier: null,
      projectId: thread.projectId,
    });
  });
}

test.each([
  {
    name: "Fork keeps the source project",
    sourceProjectId: PROJECT_ID,
    expectedProjectId: PROJECT_ID,
  },
  {
    name: "Fork keeps an unassigned source outside projects",
    sourceProjectId: null,
    expectedProjectId: null,
  },
])("$name", async ({ sourceProjectId, expectedProjectId }) => {
  installProjectConversation(sourceProjectId);
  await setupPage({
    context,
    path: RUN_PATH,
  });
  const originalComposer = await screen.findByRole("textbox", {
    name: "Message",
  });
  const notifications = screen.getByRole("region", {
    name: /^Notifications\b/,
  });
  await fill(originalComposer, "Keep my unfinished notes");
  if (sourceProjectId) {
    const toggle = await findEnabledButton("Show or hide chats in Launch");
    if (toggle.getAttribute("aria-expanded") === "false") {
      click(toggle);
    }
  }
  await waitFor(() => {
    expect(
      document.querySelector(
        `[data-sidebar-chat-thread-id="${RUN_THREAD_ID}"]`,
      ),
    ).toBeInTheDocument();
  });
  await selectPassage(PASSAGE);
  click(await findEnabledButton("Fork"));
  const dialog = await screen.findByRole("dialog", { name: "Okou" });
  await fill(
    await within(dialog).findByRole("textbox", { name: "Add a message" }),
    "Explore another launch plan",
  );
  click(await findEnabledButton("Send", dialog));

  await within(notifications).findByText("New chat created");
  const newThread = await waitFor(() => {
    const link = document.querySelector<HTMLElement>(
      `[data-sidebar-chat-thread-id]:not([data-sidebar-chat-thread-id="${RUN_THREAD_ID}"])`,
    );
    expect(link).toBeInTheDocument();
    return link!;
  });
  expect(
    newThread.closest<HTMLElement>("[data-project-row-id]")?.dataset
      .projectRowId ?? null,
  ).toBe(expectedProjectId);
  const sourceThread = document.querySelector<HTMLElement>(
    `[data-sidebar-chat-thread-id="${RUN_THREAD_ID}"]`,
  );
  expect(sourceThread).toBeInTheDocument();
  expect(
    sourceThread?.closest<HTMLElement>("[data-project-row-id]")?.dataset
      .projectRowId ?? null,
  ).toBe(sourceProjectId);
  expect(location.pathname).toBe(RUN_PATH);
  expect(originalComposer).toHaveTextContent("Keep my unfinished notes");
});

test("F opens a Fork composer carrying the captured selection", async () => {
  installCapabilityChat({
    events: completedConversation(`The ${PASSAGE}.`),
  });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  await screen.findByRole("textbox", { name: "Message" });
  await selectPassage(PASSAGE);

  fireEvent.keyDown(document, { key: "f" });

  const dialog = await screen.findByRole("dialog", { name: "Okou" });
  const editor = await within(dialog).findByRole("textbox", {
    name: "Message",
  });
  expect(within(dialog).getByText(PASSAGE)).toBeInTheDocument();
  await fill(editor, "Focus on the launch risks");
  expect(editor).toHaveTextContent("Focus on the launch risks");
});

test("Fork sends the selected passage and its source to a new personal chat", async () => {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(`The ${PASSAGE}.`, "An unrelated answer."),
    onSend(send) {
      sends.push(send);
    },
  });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  const originalComposer = await screen.findByRole("textbox", {
    name: "Message",
  });
  const notifications = screen.getByRole("region", {
    name: /^Notifications\b/,
  });
  await fill(originalComposer, "Keep my unfinished notes");
  await selectPassage(PASSAGE);
  click(await findEnabledButton("Fork"));
  const dialog = await screen.findByRole("dialog", { name: "Okou" });
  const note = await within(dialog).findByRole("textbox", {
    name: "Add a message",
  });
  const user = userEvent.setup({ delay: null });
  await user.type(note, "Explore the risks in a separate conversation");

  click(await findEnabledButton("Send", dialog));

  await within(notifications).findByText("New chat created");
  const send = await waitForSend(sends, 1);
  expect(send.threadId).toStrictEqual(expect.any(String));
  expect(send.threadId).not.toBe(RUN_THREAD_ID);
  expect(send.sourceRunId).toBe(FIRST_CAPABILITY_RUN_ID);
  expect(send.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "feedback", quote: PASSAGE }),
    ]),
  );
  expect(send.prompt).toContain("Explore the risks in a separate conversation");
  expect(send.prompt).not.toContain("An unrelated answer.");
  expect(originalComposer).toHaveTextContent("Keep my unfinished notes");
});
