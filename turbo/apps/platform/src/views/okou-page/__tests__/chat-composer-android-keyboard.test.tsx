import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  draftLines,
  openDraft,
  pressNativeEnter,
} from "./composer-native-keyboard-test-helpers.ts";

const { browser } = vi.hoisted(() => {
  const browser = {
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 " +
      "Chrome/140.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    vendor: "Google Inc.",
  };
  // ProseMirror caches Android/Chrome detection at import time and skips
  // keyCode 13 in its ordinary keydown handler. Runtime UA mocks miss this.
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(browser.userAgent);
  vi.spyOn(navigator, "vendor", "get").mockReturnValue(browser.vendor);
  return { browser };
});

test.each([false, true])(
  "hardware Enter (Ctrl=%s) sends once after composition ends",
  async (ctrlKey) => {
    const sentPrompts: string[] = [];
    const editor = await openDraft(browser, "Hardware draft", sentPrompts);
    await waitFor(() => {
      const send = queryAllByRoleFast("button").find((button) => {
        return button.getAttribute("aria-label") === "Send";
      });
      expect(send).toBeEnabled();
    });

    fireEvent.compositionStart(editor);
    pressNativeEnter(editor, { ctrlKey, isComposing: true, keyCode: 229 });
    expect(draftLines(editor)).toStrictEqual(["Hardware draft"]);
    expect(
      document.querySelector('[data-role="user"]'),
    ).not.toBeInTheDocument();
    fireEvent.compositionEnd(editor);
    pressNativeEnter(editor, { ctrlKey });

    await waitFor(() => {
      expect(document.querySelector('[data-role="user"]')).toHaveTextContent(
        "Hardware draft",
      );
    });
    expect(sentPrompts).toStrictEqual(["Hardware draft"]);
  },
);

test.each(["First line", "/"])(
  "shift+Enter splits %s once without choosing a menu item or sending",
  async (firstLine) => {
    const user = userEvent.setup({ delay: null });
    const sentPrompts: string[] = [];
    const editor = await openDraft(browser, firstLine, sentPrompts);
    if (firstLine === "/") {
      const menu = await screen.findByTestId("slash-workflow-menu");
      await within(menu).findByText("regression-workflow");
    }

    pressNativeEnter(editor, { shiftKey: true });
    expect(draftLines(editor)).toStrictEqual([firstLine, ""]);
    await user.keyboard("Second line");

    expect(draftLines(editor)).toStrictEqual([firstLine, "Second line"]);
    expect(editor.querySelector("br")).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
    expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-role="user"]'),
    ).not.toBeInTheDocument();
    expect(sentPrompts).toHaveLength(0);
  },
);
