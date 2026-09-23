import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  findComposer,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

const { appleBrowsers } = vi.hoisted(() => {
  const appleBrowsers = [
    {
      name: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 " +
        "Mobile/15E148 Safari/604.1",
      platform: "iPhone",
    },
    {
      name: "iPad desktop mode",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      platform: "MacIntel",
    },
  ] as const;
  // ProseMirror caches iOS detection at import time. Set the browser boundary
  // before importing the real Router/editor; runtime mocks alone miss its
  // delayed Enter replay. This covers compatibility logic, not native WebKit.
  vi.spyOn(navigator, "vendor", "get").mockReturnValue("Apple Computer, Inc.");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    appleBrowsers[1].userAgent,
  );
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
  return { appleBrowsers };
});

async function openDraft(
  browser: (typeof appleBrowsers)[number],
  text: string,
  sentPrompts: string[],
  coarsePointer = true,
): Promise<HTMLElement> {
  // restoreMocks resets the import-time spies before each test.
  vi.spyOn(navigator, "vendor", "get").mockReturnValue("Apple Computer, Inc.");
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
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return respond(200, [
      {
        id: "c0000000-0000-4000-a000-000000000072",
        agentId: MESSAGE_EXPERIENCE_AGENT_ID,
        agentName: null,
        agentDisplayName: "Message Agent",
        name: "regression-workflow",
        displayName: "Regression workflow",
        description: "A selectable slash suggestion",
        visibility: "public",
        ownerUserId: "user-1",
        createdAt: "2026-09-23T00:00:00.000Z",
        canManage: true,
        canPublish: false,
        official: null,
        shadowedBy: null,
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

function draftLines(editor: HTMLElement): string[] {
  return Array.from(editor.children)
    .filter((child): child is HTMLParagraphElement => {
      return child instanceof HTMLParagraphElement;
    })
    .map((paragraph) => {
      return paragraph.textContent ?? "";
    });
}

function pressNativeEnter(
  editor: HTMLElement,
  options: {
    readonly shiftKey?: boolean;
    readonly isComposing?: boolean;
    readonly keyCode?: number;
  } = {},
): void {
  // userEvent leaves keyCode at zero. This exact Safari keydown must carry 13
  // to enter ProseMirror's iOS replay path (or 229 for IME confirmation).
  fireEvent.keyDown(editor, {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    ...options,
  });
}

describe.each(appleBrowsers)("$name", (browser) => {
  it.each(["First line", "/"])(
    "keeps %s on two lines after Shift+Enter without selecting or sending",
    async (firstLine) => {
      const user = userEvent.setup({ delay: null });
      const sentPrompts: string[] = [];
      const editor = await openDraft(browser, firstLine, sentPrompts);
      if (firstLine === "/") {
        const menu = await screen.findByTestId("slash-workflow-menu");
        await within(menu).findByText("A selectable slash suggestion");
      }

      pressNativeEnter(editor, { shiftKey: true });

      // The original key must split synchronously, before the delayed replay
      // can drop Shift and select a slash command instead.
      expect(draftLines(editor)).toStrictEqual([firstLine, ""]);
      await user.keyboard("Second line");
      expect(draftLines(editor)).toStrictEqual([firstLine, "Second line"]);
      expect(editor.querySelector("br")).not.toBeInTheDocument();
      expect(editor).toHaveFocus();
      expect(
        screen.queryByTestId("slash-workflow-menu"),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(sentPrompts).toHaveLength(0);
      expect(
        document.querySelector('[data-role="user"]'),
      ).not.toBeInTheDocument();
    },
  );

  it.each([13, 229])(
    "composition confirmation with keyCode %i preserves the draft",
    async (keyCode) => {
      const user = userEvent.setup({ delay: null });
      const sentPrompts: string[] = [];
      const editor = await openDraft(browser, "Composition draft", sentPrompts);

      fireEvent.compositionStart(editor);
      pressNativeEnter(editor, { shiftKey: true, isComposing: true });
      expect(draftLines(editor)).toStrictEqual(["Composition draft"]);
      fireEvent.compositionEnd(editor);
      // Safari can clear isComposing before the confirming Enter arrives.
      pressNativeEnter(editor, { shiftKey: true, keyCode });
      expect(draftLines(editor)).toStrictEqual(["Composition draft"]);

      // The guard consumes only the confirmation key. A subsequent intentional
      // Shift+Enter must work immediately, even inside that 500ms interval.
      pressNativeEnter(editor, { shiftKey: true });
      expect(draftLines(editor)).toStrictEqual(["Composition draft", ""]);
      await user.keyboard("Second line");
      expect(draftLines(editor)).toStrictEqual([
        "Composition draft",
        "Second line",
      ]);
      expect(editor).toHaveFocus();
      expect(sentPrompts).toHaveLength(0);
      expect(
        document.querySelector('[data-role="user"]'),
      ).not.toBeInTheDocument();
    },
  );

  it("fine-pointer Enter respects the send preference", async () => {
    const sentPrompts: string[] = [];
    const editor = await openDraft(
      browser,
      "Send from the keyboard",
      sentPrompts,
      false,
    );
    await waitFor(() => {
      const send = queryAllByRoleFast("button").find((button) => {
        return button.getAttribute("aria-label") === "Send";
      });
      expect(send).toBeEnabled();
    });

    pressNativeEnter(editor);

    await waitFor(() => {
      expect(sentPrompts).toStrictEqual(["Send from the keyboard"]);
      expect(document.querySelector('[data-role="user"]')).toHaveTextContent(
        "Send from the keyboard",
      );
    });
  });
});
