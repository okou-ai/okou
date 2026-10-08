import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  findComposer,
  findFastControl,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const COMPOSER_PLACEHOLDER = "Ask me to automate workflows, manage tasks...";
const TOUCH_CHAT_THREAD_ID = "c0000000-0000-4000-a000-000000000054";

function installComposerChat(
  sentPrompts: string[],
  sendMode: "enter" | "cmd-enter",
): void {
  context.mocks.data.userPreferences({ sendMode });
  installMessageExperienceChat({
    onSendRequest: ({ prompt }) => {
      sentPrompts.push(prompt);
    },
  });
}

async function loadNewChatComposer(): Promise<HTMLElement> {
  await expect(screen.findByTestId("start-cards")).resolves.toBeVisible();
  return await findComposer();
}

function draftLines(editor: HTMLElement): string[] {
  return Array.from(editor.children)
    .filter((child): child is HTMLParagraphElement => {
      return child instanceof HTMLParagraphElement;
    })
    .map((paragraph) => {
      return paragraph.textContent ?? "";
    });
}

async function expectSentPrompt(prompt: string): Promise<void> {
  await waitFor(() => {
    const sentMessage = Array.from(
      document.querySelectorAll<HTMLElement>('[data-role="user"]'),
    ).find((message) => {
      return message.textContent?.includes(prompt);
    });
    expect(sentMessage).toBeVisible();
  });
}

async function expectAgentWorking(): Promise<void> {
  await waitFor(() => {
    expect(queryFastControl("button", "Stop")).toBeVisible();
    expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
  });
}

interface TouchViewportFixture {
  readonly closeSoftwareKeyboard: () => void;
  readonly openSoftwareKeyboard: () => void;
}

function installTouchViewport(): TouchViewportFixture {
  const layoutHeight = 800;
  const keyboardHeight = 320;
  const visualViewportDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "visualViewport",
  );
  const innerHeightDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "innerHeight",
  );
  const viewport = Object.assign(new EventTarget(), {
    height: layoutHeight - keyboardHeight,
    offsetLeft: 0,
    offsetTop: 0,
    onresize: null,
    onscroll: null,
    onscrollend: null,
    pageLeft: 0,
    pageTop: 0,
    scale: 1,
    width: 1024,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: layoutHeight,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (innerHeightDescriptor) {
        Object.defineProperty(window, "innerHeight", innerHeightDescriptor);
      } else {
        Reflect.deleteProperty(window, "innerHeight");
      }
      if (visualViewportDescriptor) {
        Object.defineProperty(
          window,
          "visualViewport",
          visualViewportDescriptor,
        );
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    },
    { once: true },
  );

  function setSoftwareKeyboardOpen(open: boolean): void {
    viewport.height = open ? layoutHeight - keyboardHeight : layoutHeight;
    viewport.dispatchEvent(new Event("resize"));
  }

  return {
    closeSoftwareKeyboard: () => {
      setSoftwareKeyboardOpen(false);
    },
    openSoftwareKeyboard: () => {
      setSoftwareKeyboardOpen(true);
    },
  };
}

test("Send with the Enter key preference", async () => {
  const user = userEvent.setup({ delay: null });
  const sentPrompts: string[] = [];
  installComposerChat(sentPrompts, "enter");

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
  });

  const editor = await loadNewChatComposer();
  await fill(editor, "Prepare the launch summary");
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(sentPrompts).toStrictEqual(["Prepare the launch summary"]);
  });
  await expectSentPrompt("Prepare the launch summary");
  await expectAgentWorking();
});

test("Shift-Enter keeps an active chat's follow-up draft on two lines without sending", async () => {
  const user = userEvent.setup({ delay: null });
  const sentPrompts: string[] = [];
  const threadId = "c0000000-0000-4000-a000-000000000055";
  const runId = "c0000000-0000-4000-a000-000000000056";
  context.mocks.data.userPreferences({ sendMode: "enter" });
  installMessageExperienceChat({
    threadId,
    chatEvents: [
      {
        id: "active-keyboard-prompt",
        role: "user",
        content: "Prepare the launch summary",
        runId,
        createdAt: "2026-08-01T00:00:00Z",
      },
    ],
    activeRunIds: [runId],
    onSendRequest: ({ prompt }) => {
      sentPrompts.push(prompt);
    },
  });
  await setupPage({ context, path: `/chats/${threadId}` });
  await expectAgentWorking();
  const editor = await findComposer();
  await fill(editor, "Keep this draft");
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  await user.keyboard("on two lines");
  expect(draftLines(editor)).toStrictEqual(["Keep this draft", "on two lines"]);
  expect(editor).toHaveFocus();
  expect(sentPrompts).toStrictEqual([]);
});

test("Send with the command-key preference", async () => {
  const user = userEvent.setup({ delay: null });
  const sentPrompts: string[] = [];
  context.mocks.browser.userAgent("Mozilla/5.0 (X11; Linux x86_64)");
  installComposerChat(sentPrompts, "cmd-enter");

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
  });

  const editor = await loadNewChatComposer();
  await fill(editor, "Review the campaign");
  await user.keyboard("{Enter}");
  await user.keyboard("before publishing");
  expect(draftLines(editor)).toStrictEqual([
    "Review the campaign",
    "before publishing",
  ]);
  expect(editor).toHaveFocus();
  expect(sentPrompts).toHaveLength(0);

  await user.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => {
    expect(sentPrompts).toStrictEqual([
      "Review the campaign\nbefore publishing",
    ]);
  });
  await expectSentPrompt("Review the campaign");
  await expectAgentWorking();
});

test("Avoid sending while text composition is in progress", async () => {
  const sentPrompts: string[] = [];
  installComposerChat(sentPrompts, "enter");

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
  });

  const editor = await loadNewChatComposer();
  await fill(editor, "かな");
  fireEvent.compositionStart(editor, { data: "かな" });
  fireEvent.keyDown(editor, {
    code: "Enter",
    isComposing: true,
    key: "Enter",
    keyCode: 229,
  });
  fireEvent.compositionEnd(editor, { data: "かな" });
  fireEvent.compositionStart(editor, { data: "かな" });
  fireEvent.keyDown(editor, {
    code: "Enter",
    ctrlKey: true,
    isComposing: true,
    key: "Enter",
    keyCode: 229,
  });
  fireEvent.compositionEnd(editor, { data: "かな" });

  expect(editor).toHaveTextContent("かな");
  expect(editor).toHaveFocus();
  expect(sentPrompts).toHaveLength(0);
  expect(
    document.querySelectorAll<HTMLElement>('[data-role="user"]'),
  ).toHaveLength(0);
});

test("Use the appropriate Enter behavior on touch devices", async () => {
  const user = userEvent.setup({ delay: null });
  const sentPrompts: string[] = [];
  context.mocks.browser.userAgent("Mozilla/5.0 (Linux; Android 15)");
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)" || query === "(any-pointer: fine)";
  });
  const viewport = installTouchViewport();
  context.mocks.data.userPreferences({ sendMode: "enter" });
  installMessageExperienceChat({
    threadId: TOUCH_CHAT_THREAD_ID,
    onSendRequest: ({ prompt }) => {
      sentPrompts.push(prompt);
    },
  });

  await setupPage({
    context,
    path: `/chats/${TOUCH_CHAT_THREAD_ID}`,
  });

  let editor = await screen.findByRole("textbox", { name: "Message" });
  await fill(editor, "Draft from the on-screen keyboard");
  await user.keyboard("{Enter}");
  await user.keyboard("with a second line");
  expect(draftLines(editor)).toStrictEqual([
    "Draft from the on-screen keyboard",
    "with a second line",
  ]);
  expect(sentPrompts).toHaveLength(0);

  viewport.closeSoftwareKeyboard();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(sentPrompts).toStrictEqual([
      "Draft from the on-screen keyboard\nwith a second line",
    ]);
  });
  await expectSentPrompt("Draft from the on-screen keyboard");
  await expectAgentWorking();

  viewport.openSoftwareKeyboard();
  editor = await screen.findByRole("textbox", { name: "Message" });
  expect(editor).toHaveTextContent("");
  await user.click(editor);
  await user.keyboard("Send with the hardware shortcut");
  expect(editor).toHaveTextContent("Send with the hardware shortcut");
  await waitFor(() => {
    const send = queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-label") === "Send";
    });
    expect(send).toBeEnabled();
  });
  await user.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => {
    expect(sentPrompts).toStrictEqual([
      "Draft from the on-screen keyboard\nwith a second line",
      "Send with the hardware shortcut",
    ]);
  });
  await expectSentPrompt("Send with the hardware shortcut");
});

test("Treat whitespace as an empty message", async () => {
  const sentPrompts: string[] = [];
  installComposerChat(sentPrompts, "enter");
  context.mocks.data.agents([
    {
      agentId: MESSAGE_EXPERIENCE_AGENT_ID,
      displayName: "Scout",
    },
  ]);

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
  });

  const editor = await loadNewChatComposer();
  const composer = editor.closest("[data-slot='chat-composer-card']");
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Composer surface not found");
  }
  const send = await findFastControl("button", "Send", composer);
  expect(within(composer).getByText(COMPOSER_PLACEHOLDER)).toBeVisible();
  expect(send).toBeDisabled();

  await fill(editor, " ");
  expect(editor.textContent).toBe(" ");
  await waitFor(() => {
    expect(within(composer).queryByText(COMPOSER_PLACEHOLDER)).toBeNull();
  });
  expect(send).toBeDisabled();
  expect(sentPrompts).toHaveLength(0);
});
