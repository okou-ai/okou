import { workflowsCollectionContract } from "@okouai/api-contracts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  THREAD_ID,
  composerWorkflow,
  context,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockPersonalModelRoutes,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const HINT = " Search workflows or choose a template…";

function slashHint(editor: HTMLElement): HTMLElement | null {
  // The visible copy is generated content, like the quoted-note placeholder.
  return editor.querySelector(`[data-placeholder="${HINT}"]`);
}

async function openComposer(
  enabled = true,
  path = `/agents/${AGENT_ID}/chat`,
  sentPrompts: string[] = [],
): Promise<HTMLElement> {
  mockAgent();
  mockPersonalModelRoutes();
  mockBillingCapabilities({ restrictedBuiltInModels: false });
  context.mocks.data.userPreferences({ sendMode: "enter" });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [composerWorkflow("weekly-recap", "Prepare a recap")]);
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    onSendRequest: ({ prompt }) => {
      sentPrompts.push(prompt);
    },
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.ComposerSlashHint]: enabled },
  });
  return await findComposerEditor();
}

function selectText(editor: HTMLElement, from: number, to = from): void {
  const text = editor.querySelector("p")?.firstChild;
  const selection = window.getSelection();
  if (!(text instanceof Text) || !selection) {
    throw new Error("Composer text selection is unavailable");
  }
  selection.setBaseAndExtent(text, from, text, to);
  fireEvent(document, new Event("selectionchange"));
}

test("Keep slash suggestions without the inline hint when the switch is off", async () => {
  const editor = await openComposer(false);
  await fill(editor, "Draft /");
  await screen.findByTestId("slash-workflow-menu");
  expect(slashHint(editor)).toBeNull();
  expect(editor.textContent).toBe("Draft /");
});

test.each([`/agents/${AGENT_ID}/chat`, `/chats/${THREAD_ID}`])(
  "Show the hint after a bare slash and dismiss it with the menu at %s",
  async (path) => {
    const user = userEvent.setup({ delay: null });
    const editor = await openComposer(true, path);
    await fill(editor, "Draft /");
    await waitFor(() => {
      expect(slashHint(editor)).toBeInTheDocument();
    });
    expect(editor.textContent).toBe("Draft /");
    expect(editor).toHaveFocus();

    await user.keyboard("weekly");
    expect(screen.getByTestId("slash-workflow-menu")).toBeInTheDocument();
    expect(slashHint(editor)).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(editor.textContent).toBe("Draft /weekly-recap ");
    });
    expect(slashHint(editor)).toBeNull();

    await fill(editor, "Draft /");
    await waitFor(() => {
      expect(slashHint(editor)).toBeInTheDocument();
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
      expect(slashHint(editor)).toBeNull();
    });
    expect(editor.textContent).toBe("Draft /");
    expect(editor).toHaveFocus();
  },
);

test("Keep the hint out of copied and sent text and hide it for a selection", async () => {
  const user = userEvent.setup({ delay: null });
  const sentPrompts: string[] = [];
  const editor = await openComposer(
    true,
    `/agents/${AGENT_ID}/chat`,
    sentPrompts,
  );
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(slashHint(editor)).toBeInTheDocument();
  });
  selectText(editor, 0, 7);
  await waitFor(() => {
    expect(slashHint(editor)).toBeNull();
  });
  const clipboardData = new DataTransfer();
  fireEvent.copy(editor, { clipboardData });
  expect(clipboardData.getData("text/plain")).toBe("Draft /");
  expect(clipboardData.getData("text/html")).not.toContain(HINT.trim());

  selectText(editor, 7);
  await waitFor(() => {
    expect(slashHint(editor)).toBeInTheDocument();
  });
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(sentPrompts).toStrictEqual(["Draft /"]);
  });
});

test("Preserve IME confirmation while the slash hint is present", async () => {
  const user = userEvent.setup({ delay: null });
  const sentPrompts: string[] = [];
  const editor = await openComposer(
    true,
    `/agents/${AGENT_ID}/chat`,
    sentPrompts,
  );
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(slashHint(editor)).toBeInTheDocument();
  });
  fireEvent.compositionStart(editor, { data: "周报" });
  expect(slashHint(editor)).toBeNull();
  fireEvent.keyDown(editor, {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(editor).toHaveFocus();
  expect(editor.textContent).toBe("Draft /");
  expect(sentPrompts).toStrictEqual([]);
  expect(screen.getByTestId("slash-workflow-menu")).toBeInTheDocument();
  fireEvent.compositionEnd(editor, { data: "周报" });
  expect(slashHint(editor)).toBeInTheDocument();
  await user.keyboard("周报");
  expect(editor.textContent).toBe("Draft /周报");
  expect(slashHint(editor)).toBeNull();
});

test("Follow a slash on a new line without treating a URL or token suffix as an empty query", async () => {
  const user = userEvent.setup({ delay: null });
  const editor = await openComposer();
  await fill(editor, "https://example.com/");
  expect(slashHint(editor)).toBeNull();
  await fill(editor, "/weekly");
  selectText(editor, 1);
  await screen.findByTestId("slash-workflow-menu");
  expect(slashHint(editor)).toBeNull();

  await fill(editor, "First line");
  await user.keyboard("{Shift>}{Enter}{/Shift}/");
  await waitFor(() => {
    expect(slashHint(editor)).toBeInTheDocument();
  });
  expect(editor.querySelectorAll("p")).toHaveLength(2);
  expect(editor.lastElementChild?.textContent).toBe("/");
  await user.keyboard("{Backspace}");
  expect(slashHint(editor)).toBeNull();
});
