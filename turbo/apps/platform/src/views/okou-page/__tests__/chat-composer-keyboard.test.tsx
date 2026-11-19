import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  MESSAGE_EXPERIENCE_AGENT_ID,
  createMessageExperienceHelpers,
  findComposer,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);

const TOUCH_CHAT_THREAD_ID = "c0000000-0000-4000-a000-000000000054";

function draftLines(editor: HTMLElement): string[] {
  return Array.from(editor.children)
    .filter((child): child is HTMLParagraphElement => {
      return child instanceof HTMLParagraphElement;
    })
    .map((paragraph) => {
      return paragraph.textContent ?? "";
    });
}

async function expectUserMessage(lines: readonly string[]): Promise<void> {
  await waitFor(() => {
    const message = Array.from(
      document.querySelectorAll<HTMLElement>('[data-role="user"]'),
    ).find((candidate) => {
      return lines.every((line) => {
        return candidate.textContent?.includes(line);
      });
    });
    expect(message).toBeVisible();
  });
}

async function expectAgentWorking(): Promise<void> {
  await waitFor(() => {
    expect(queryFastControl("button", "Stop")).toBeVisible();
    expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
  });
}

function installSoftwareKeyboardViewport(): {
  readonly close: () => void;
  readonly open: () => void;
} {
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

  function setOpen(open: boolean): void {
    viewport.height = open ? layoutHeight - keyboardHeight : layoutHeight;
    viewport.dispatchEvent(new Event("resize"));
  }

  return {
    close: () => {
      setOpen(false);
    },
    open: () => {
      setOpen(true);
    },
  };
}

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
  context.mocks.data.userPreferences({ sendMode: "cmd-enter" });
  installMessageExperienceChat({
    onSendRequest: ({ prompt }) => {
      sentPrompts.push(prompt);
    },
  });
  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
  });
  const editor = await findComposer();

  await fill(editor, "Review the campaign");
  await user.keyboard("{Enter}");
  await user.keyboard("before publishing");
  expect(draftLines(editor)).toStrictEqual([
    "Review the campaign",
    "before publishing",
  ]);
  expect(editor).toHaveFocus();
  expect(sentPrompts).toStrictEqual([]);

  await user.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => {
    expect(sentPrompts).toStrictEqual([
      "Review the campaign\nbefore publishing",
    ]);
  });
  await expectUserMessage(["Review the campaign", "before publishing"]);
  await expectAgentWorking();
});

test("Use the appropriate Enter behavior on touch devices", async () => {
  const user = userEvent.setup({ delay: null });
  const sentPrompts: string[] = [];
  context.mocks.browser.userAgent("Mozilla/5.0 (Linux; Android 15)");
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)" || query === "(any-pointer: fine)";
  });
  const softwareKeyboard = installSoftwareKeyboardViewport();
  context.mocks.data.userPreferences({ sendMode: "enter" });
  installMessageExperienceChat({
    threadId: TOUCH_CHAT_THREAD_ID,
    onSendRequest: ({ prompt }) => {
      sentPrompts.push(prompt);
    },
  });
  await setupPage({ context, path: `/chats/${TOUCH_CHAT_THREAD_ID}` });

  let editor = await screen.findByRole("textbox", { name: "Message" });
  await fill(editor, "Draft from the on-screen keyboard");
  await user.keyboard("{Enter}");
  await user.keyboard("with a second line");
  expect(draftLines(editor)).toStrictEqual([
    "Draft from the on-screen keyboard",
    "with a second line",
  ]);
  expect(sentPrompts).toStrictEqual([]);

  softwareKeyboard.close();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(sentPrompts).toStrictEqual([
      "Draft from the on-screen keyboard\nwith a second line",
    ]);
  });
  await expectUserMessage([
    "Draft from the on-screen keyboard",
    "with a second line",
  ]);
  await expectAgentWorking();

  softwareKeyboard.open();
  editor = await screen.findByRole("textbox", { name: "Message" });
  await user.click(editor);
  await user.keyboard("Send with the hardware shortcut");
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
});
