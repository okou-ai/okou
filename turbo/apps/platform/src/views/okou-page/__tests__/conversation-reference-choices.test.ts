import { expect, test } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

const context = testContext();
const favorites = [
  "Saved Zeta mention",
  "Zeta launch notes",
  "Scout planning",
] as const;
async function draft(newChat: boolean, titles: readonly string[] = favorites) {
  const active = continuityThread(179, 1, "Writing desk");
  const choices = titles.map((name, i) => {
    return continuityThread(179, 8 - i, name);
  });
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 179,
    threads: [...choices, active],
  });
  context.mocks.browser.matchMedia((q) => {
    return q.includes("min-width");
  });
  await setupPage({
    context,
    ...pageOptions,
    path: newChat ? "/?compose=1" : "/chats/" + active.id,
  });
  return {
    editor: await findComposerEditor(),
    user: userEvent.setup({ delay: null }),
  };
}
function menu() {
  return screen.findByTestId("chat-thread-suggestion-menu");
}
function activeChoice(panel: HTMLElement) {
  return queryAllByRoleFast("button", panel)
    .filter((button) => {
      return button.dataset.active === "true";
    })
    .map((button) => {
      return button.textContent;
    });
}
async function inserted(editor: HTMLElement, title: string) {
  await waitFor(() => {
    expect(
      editor.querySelector("[data-chat-thread-mention]"),
    ).toHaveTextContent(title);
    expect(screen.queryByTestId("chat-thread-suggestion-menu")).toBeNull();
    expect(editor).toHaveFocus();
  });
}
test("chat-composer-mentions-001 Typing beta ranks matching conversations and inserts the highlighted follow-up", async () => {
  const names = ["Project Beta follow-up", "Project Beta"];
  const { editor, user } = await draft(false, names);
  await fill(editor, "@beta");
  const panel = await menu();
  expect(
    queryAllByRoleFast("button", panel).map((b) => {
      return b.textContent;
    }),
  ).toStrictEqual(names);
  expect(activeChoice(panel)).toStrictEqual([names[0]]);
  await user.keyboard("{ArrowUp}");
  expect(activeChoice(panel)).toStrictEqual([names[0]]);
  await user.keyboard("{ArrowDown}");
  expect(activeChoice(panel)).toStrictEqual([names[1]]);
  await user.keyboard("{ArrowUp}{Enter}");
  await inserted(editor, names[0]!);
});
async function rankedChoices(newChat: boolean) {
  const { editor, user } = await draft(newChat);
  await fill(editor, "@");
  const panel = await menu();
  expect(
    queryAllByRoleFast("button", panel)
      .slice(0, 3)
      .map((button) => {
        return button.textContent;
      }),
  ).toStrictEqual(favorites);
  expect(activeChoice(panel)).toStrictEqual([favorites[0]]);
  await user.keyboard("{ArrowUp}");
  expect(activeChoice(panel)).toStrictEqual([favorites[0]]);
  await user.keyboard("{ArrowDown}");
  expect(activeChoice(panel)).toStrictEqual([favorites[1]]);
  return { editor, user, panel };
}
test("chat-composer-mentions-008 An existing chat inserts its top conversation reference after returning to it", async () => {
  const { editor, user, panel } = await rankedChoices(false);
  expect(within(panel).queryByText("Agents")).toBeNull();
  await user.keyboard("{ArrowUp}{Enter}");
  await inserted(editor, favorites[0]);
});
test("chat-composer-mentions-010 The centred start page offers ranked chats above its composer", async () => {
  const { panel } = await rankedChoices(true);
  expect(panel.closest("[data-side]")).toHaveAttribute("data-side", "top");
});
test("chat-composer-mentions-011 Tab inserts the second highlighted chat and closes the choices", async () => {
  const { editor, user } = await draft(false);
  await fill(editor, "@");
  const panel = await menu();
  await user.keyboard("{ArrowDown}");
  expect(activeChoice(panel)).toStrictEqual(["Zeta launch notes"]);
  await user.keyboard("{Tab}");
  await inserted(editor, "Zeta launch notes");
});
const hint = '[data-placeholder*="Search chats or projects"]';
test.each([
  ["chat-composer-mentions-004", false],
  ["chat-composer-mentions-005", true],
] as const)(
  "%s IME confirmation leaves the chat reference uncommitted and Escape preserves the draft",
  async (_id, newChat) => {
    const { editor, user } = await draft(newChat);
    await fill(editor, "Draft @");
    await menu();
    expect(editor.querySelector(hint)).toBeInTheDocument();
    fireEvent.compositionStart(editor);
    await waitFor(() => {
      return expect(editor.querySelector(hint)).toBeNull();
    });
    fireEvent.keyDown(editor, {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    expect(editor.querySelector("[data-chat-thread-mention]")).toBeNull();
    await expect(menu()).resolves.toBeInTheDocument();
    fireEvent.compositionEnd(editor);
    await waitFor(() => {
      return expect(editor.querySelector(hint)).toBeInTheDocument();
    });
    await fill(editor, "Draft @launch");
    const panel = await menu();
    await waitFor(() => {
      return expect(activeChoice(panel)).toStrictEqual(["Zeta launch notes"]);
    });
    expect(editor.querySelector(hint)).toBeNull();
    await user.keyboard("{Enter}");
    await inserted(editor, "Zeta launch notes");
    expect(editor.querySelector(hint)).toBeNull();
    await fill(editor, "Draft @");
    await menu();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      return expect(
        screen.queryByTestId("chat-thread-suggestion-menu"),
      ).toBeNull();
    });
    expect(editor.querySelector(hint)).toBeNull();
    expect(editor).toHaveTextContent(/^Draft @$/);
    expect(editor).toHaveFocus();
  },
);
