import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findComposer,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

interface NativeKeyboardBrowser {
  readonly userAgent: string;
  readonly platform: string;
  readonly vendor: string;
}

export async function openDraft(
  browser: NativeKeyboardBrowser,
  text: string,
  sentPrompts: string[],
  coarsePointer = true,
): Promise<HTMLElement> {
  // restoreMocks resets the import-time spies before each test.
  vi.spyOn(navigator, "vendor", "get").mockReturnValue(browser.vendor);
  context.mocks.browser.userAgent(browser.userAgent);
  context.mocks.browser.platform(browser.platform);
  context.mocks.browser.maxTouchPoints(5);
  context.mocks.browser.matchMedia((query) => {
    return (
      (coarsePointer && query === "(pointer: coarse)") ||
      query === "(any-pointer: fine)"
    );
  });
  context.mocks.data.userPreferences({ sendMode: "enter" });
  installMessageExperienceChat({
    onSendRequest: ({ prompt }) => {
      sentPrompts.push(prompt);
    },
  });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [
      {
        id: "c0000000-0000-4000-a000-000000000072",
        name: "regression-workflow",
        displayName: "Regression workflow",
        description: "A selectable slash suggestion",
      },
    ]);
  });
  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
  });
  await screen.findByTestId("start-cards");
  const editor = await findComposer();
  const user = userEvent.setup({ delay: null });
  const paragraph = editor.querySelector("p");
  if (!paragraph) {
    throw new Error("Expected an empty composer paragraph");
  }
  // Happy DOM has no caret hit-testing. A root click places the caret after
  // the empty paragraph, so place this user click inside its first text line.
  await user.pointer({
    target: editor,
    node: paragraph,
    offset: 0,
    keys: "[MouseLeft]",
  });
  await user.keyboard(text);
  await waitFor(() => {
    expect(draftLines(editor)).toStrictEqual([text]);
  });
  return editor;
}

export function draftLines(editor: HTMLElement): string[] {
  return Array.from(editor.children)
    .filter((child): child is HTMLParagraphElement => {
      return child instanceof HTMLParagraphElement;
    })
    .map((paragraph) => {
      return paragraph.textContent ?? "";
    });
}

export function pressNativeEnter(
  editor: HTMLElement,
  options: {
    readonly shiftKey?: boolean;
    readonly isComposing?: boolean;
    readonly keyCode?: number;
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
  } = {},
): void {
  // userEvent leaves keyCode at zero. Carry 13 to enter ProseMirror's
  // Android skip/iOS replay paths, or 229 for an IME confirmation.
  fireEvent.keyDown(editor, {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    ...options,
  });
}
