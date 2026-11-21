import type { ChatRecommendedFollowup } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getNamedButton,
  mockAttachmentChat,
  mockSplitAttachmentChats,
  ATTACHMENT_THREAD_ID,
  SECOND_ATTACHMENT_THREAD_ID,
} from "./chat-attachment-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { findLink } from "./chat-run-test-fixtures.ts";

const context = testContext();
const launchRun = "bad04caa-dbc6-43d7-a589-83a55e6723c0";
const checklistRun = "9c530ace-b8f9-448f-9bab-cde99b900f45";
const time = "2026-09-18T14:30:00.000Z";

function answered(
  reply: string,
  followups: ChatRecommendedFollowup[],
  runId = launchRun,
): MockChatEventInput[] {
  return [
    {
      role: "user",
      content: "Prepare the launch outline",
      runId,
      createdAt: time,
    },
    {
      role: "assistant",
      content: reply,
      runId,
      createdAt: time,
      runLifecycleEvent: "completed",
      followups,
    },
  ];
}

test("chat-message-followups-002 offers the late suggestion in the chat the reader switched to", async () => {
  const destination = answered(
    "The rollout checklist is ready",
    [],
    checklistRun,
  );
  mockSplitAttachmentChats(
    context,
    {
      threadId: ATTACHMENT_THREAD_ID,
      title: "Launch outline",
      events: answered("Outline approved", [
        { kind: "talk", prompt: "Review the outline" },
      ]),
    },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Rollout checklist",
      events: destination,
    },
  );
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const original = await screen.findByRole("group", { name: "Keep going" });
  expect(within(original).getByText("Review the outline")).toBeInTheDocument();
  click(await findLink("Rollout checklist"));
  const answer = await screen.findByText("The rollout checklist is ready");
  const pane = answer.closest<HTMLElement>("[data-chat-thread-container-id]")!;
  const current = within(pane);
  expect(
    current.queryByRole("group", { name: "Keep going" }),
  ).not.toBeInTheDocument();
  destination.push({
    role: "assistant",
    content: null,
    runId: checklistRun,
    createdAt: time,
    followups: [{ kind: "talk", prompt: "Check the rollout dates" }],
  });
  createChatEvent(SECOND_ATTACHMENT_THREAD_ID);
  const arrived = await current.findByRole("group", { name: "Keep going" });
  expect(
    within(arrived).getByText("Check the rollout dates"),
  ).toBeInTheDocument();
  expect(
    pane.querySelector("[data-thinking-indicator]"),
  ).not.toBeInTheDocument();
});

async function showRecommendations(choices: ChatRecommendedFollowup[]) {
  mockAttachmentChat(context, {
    chatEvents: answered("The launch outline is ready", choices),
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const choicesGroup = await screen.findByRole("group", { name: "Keep going" });
  return {
    choices: choicesGroup,
    editor: screen.getByRole("textbox", { name: "Message" }),
  };
}

function expectUnsentDraft(editor: HTMLElement, lines: string[]) {
  expect(editor.textContent).toBe(lines.join("\n"));
  expect(editor).toHaveFocus();
  const sent = document.querySelectorAll('[data-role="user"]');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveTextContent("Prepare the launch outline");
}

test("chat-message-followups-004 selects the appended slide prompt on its second press", async () => {
  const prompt = "Present the launch plan";
  const initial = "Keep the current launch context";
  const { editor, choices } = await showRecommendations([
    { kind: "generate", generationType: "presentation", prompt },
    {
      kind: "generate",
      generationType: "image",
      prompt: "Illustrate the launch",
    },
    {
      kind: "generate",
      generationType: "website",
      prompt: "Build the launch page",
    },
    { kind: "generate", prompt: "Prepare a deliverable" },
    { kind: "talk", prompt: "Discuss the timeline" },
  ]);
  await fill(editor, initial);
  click(getNamedButton(prompt, choices));
  await waitFor(() => {
    return expectUnsentDraft(editor, [initial, prompt]);
  });
  const presented = getNamedButton(prompt, choices);
  expect(presented).toBeVisible();
  click(presented);
  await waitFor(() => {
    return expect(window.getSelection()?.toString()).toBe(prompt);
  });
  expectUnsentDraft(editor, [initial, prompt]);
});

test.each([
  { id: "chat-message-followups-006", coarse: false },
  { id: "chat-message-followups-007", coarse: true },
])(
  "$id keeps workflow and email suggestions editable with their own icons",
  async ({ coarse }) => {
    context.mocks.browser.matchMedia((query) => {
      return query === (coarse ? "(pointer: coarse)" : "(any-pointer: fine)");
    });
    const workflow = "Schedule a weekly review";
    const email = "Draft the launch announcement";
    const { editor, choices } = await showRecommendations([
      { kind: "workflow", prompt: workflow },
      { kind: "email", prompt: email },
    ]);
    click(getNamedButton(workflow, choices));
    await waitFor(() => {
      return expectUnsentDraft(editor, [workflow]);
    });
    click(getNamedButton(email, choices));
    await waitFor(() => {
      return expectUnsentDraft(editor, [workflow, email]);
    });
    for (const [prompt, icon] of [
      [workflow, "route"],
      [email, "mail"],
    ] as const) {
      expect(
        getNamedButton(prompt, choices).querySelector(`svg.lucide-${icon}`),
      ).toBeInTheDocument();
    }
  },
);
