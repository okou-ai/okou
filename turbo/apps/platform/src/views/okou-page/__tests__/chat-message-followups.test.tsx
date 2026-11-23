import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";
import {
  findComposer,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";
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

const PRESENTATION_PROMPT = "Create a presentation outline";
const HANDOFF_PROMPT = "Summarize the handoff";

function installPlaceholderChats(currentFollowupInitiallyPresent: boolean) {
  const current = answered(
    "The outline is ready",
    currentFollowupInitiallyPresent
      ? [{ kind: "talk", prompt: PRESENTATION_PROMPT }]
      : [],
  );
  mockSplitAttachmentChats(
    context,
    { threadId: ATTACHMENT_THREAD_ID, title: "Outline", events: current },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Handoff response",
      events: answered(
        "The handoff is ready",
        [{ kind: "talk", prompt: HANDOFF_PROMPT }],
        checklistRun,
      ),
    },
  );
  return () => {
    current.push({
      role: "assistant",
      content: null,
      runId: launchRun,
      createdAt: time,
      followups: [{ kind: "talk", prompt: PRESENTATION_PROMPT }],
    });
    createChatEvent(ATTACHMENT_THREAD_ID);
  };
}

test.each([false, true])(
  "The placeholder button and Tab both accept the first follow-up (touch: %s)",
  async (touch) => {
    context.mocks.browser.matchMedia((query) => {
      return touch && query === "(pointer: coarse)";
    });
    mockAttachmentChat(context, {
      chatEvents: answered("The outline is ready", [
        { kind: "talk", prompt: PRESENTATION_PROMPT },
        { kind: "talk", prompt: "Review the next step" },
      ]),
    });
    await setupPage({
      context,
      path: `/chats/${ATTACHMENT_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.FollowupPlaceholder]: true },
    });
    const user = userEvent.setup({ delay: null });
    const editor = await findComposer();
    await waitFor(() => {
      expect(editor).toHaveAttribute("aria-placeholder", PRESENTATION_PROMPT);
    });
    expect(screen.getByText(PRESENTATION_PROMPT)).toBeVisible();
    expect(screen.queryByRole("group", { name: "Keep going" })).toBeNull();
    const accept = await findFastControl("button", "Use this suggestion");
    expect(accept).toHaveTextContent(touch ? "OK" : "Tab");
    await user.click(accept);
    expect(editor).toHaveFocus();
    expect(editor.textContent).toBe(PRESENTATION_PROMPT);
    expect(accept).not.toBeInTheDocument();
    await fill(editor, "");
    await user.click(editor);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    await expect(
      findFastControl("button", "Use this suggestion"),
    ).resolves.toHaveFocus();
    await user.keyboard("{Enter}");
    expect(editor.textContent).toBe(PRESENTATION_PROMPT);
    expect(editor).toHaveFocus();
    await fill(editor, "");
    expect(editor.textContent).toBe("");
    await user.click(editor);
    editor.addEventListener(
      "keydown",
      (event) => {
        event.preventDefault();
      },
      {
        capture: true,
        once: true,
      },
    );
    await user.keyboard("{Tab}");
    expect(editor.textContent).toBe("");
    await user.keyboard("{Tab}");
    expect(editor.textContent).toBe(PRESENTATION_PROMPT);
    expect(editor).toHaveFocus();
    await user.keyboard(" please");
    expect(editor.textContent).toBe(`${PRESENTATION_PROMPT} please`);
    await user.keyboard("{Tab}");
    expect(editor).not.toHaveFocus();
  },
);

test("An empty new chat has no fallback placeholder with follow-up placeholders enabled", async () => {
  mockAttachmentChat(context);
  await setupPage({
    context,
    path: "/",
    featureSwitches: { [FeatureSwitchKey.FollowupPlaceholder]: true },
  });
  const editor = await findComposer();
  await waitFor(() => {
    expect(editor).toHaveAttribute("placeholder", "");
  });
  expect(editor).toHaveAccessibleName("Message");
  expect(
    screen.queryByText("Ask me to automate workflows, manage tasks..."),
  ).toBeNull();
});

test("A late follow-up preserves the current draft and appears when cleared", async () => {
  const deliverCurrentFollowup = installPlaceholderChats(false);
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.FollowupPlaceholder]: true },
  });
  const editor = await findComposer();
  await fill(editor, "Review the estimates");
  deliverCurrentFollowup();
  await waitFor(() => {
    expect(editor).toHaveAttribute("aria-placeholder", PRESENTATION_PROMPT);
  });
  expect(editor.textContent).toBe("Review the estimates");
  expect(screen.queryByText(PRESENTATION_PROMPT)).toBeNull();
  await fill(editor, "");
  await expect(screen.findByText(PRESENTATION_PROMPT)).resolves.toBeVisible();
});

test("Switching threads uses the destination's first follow-up for Tab", async () => {
  installPlaceholderChats(true);
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.FollowupPlaceholder]: true },
  });
  await expect(screen.findByText(PRESENTATION_PROMPT)).resolves.toBeVisible();
  click(await findFastControl("link", "Handoff response"));
  const suggestion = await screen.findByText(HANDOFF_PROMPT);
  expect(suggestion).toBeVisible();
  const editor = await screen.findByPlaceholderText(HANDOFF_PROMPT);
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  await user.keyboard("{Tab}");
  expect(editor.textContent).toBe(HANDOFF_PROMPT);
});
