import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { workflowsCollectionContract } from "@okouai/api-contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  THREAD_ID,
  composerWorkflow,
  findComposerEditor,
  createChatComposerHelpers,
} from "./chat-composer-test-helpers.ts";

const context = testContext();
const { mockAgent, mockThread } = createChatComposerHelpers(context);

async function openComposer(): Promise<HTMLElement> {
  mockAgent();
  mockThread();
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [
      composerWorkflow("pr-123-review", "Review PR 123"),
      composerWorkflow("pr-124-review", "Review PR 124"),
      composerWorkflow("weekly-recap", "Prepare a recap"),
    ]);
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  return await findComposerEditor();
}

function workflowNames(): string[] {
  return Array.from(
    screen
      .getByTestId("slash-workflow-menu")
      .querySelectorAll('[data-slot="slash-workflow-name"]'),
    (element) => {
      return element.textContent ?? "";
    },
  );
}

function updateComposition(editor: HTMLElement, data: string): void {
  // A native IME publishes compositionupdate before its DOM/input update.
  // happy-dom does not implement CompositionEvent, so retain its data field
  // on the native event dispatched through the editor's public DOM boundary.
  fireEvent(
    editor,
    Object.assign(new Event("compositionupdate", { bubbles: true }), { data }),
  );
  const text = document
    .createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    .nextNode();
  if (!(text instanceof Text)) {
    throw new Error("Expected the composer's text node");
  }
  text.data = `/${data}`;
  window.getSelection()?.collapse(text, text.length);
  fireEvent.input(editor, {
    data,
    inputType: "insertCompositionText",
    isComposing: true,
  });
}

test("Filter slash workflows throughout IME composition without taking candidate keys", async () => {
  const user = userEvent.setup({ delay: null });
  const editor = await openComposer();
  await user.click(editor);
  await user.keyboard("/");
  await screen.findByTestId("slash-workflow-menu");

  await waitFor(() => {
    expect(workflowNames()).toContain("/weekly-recap");
  });

  fireEvent.compositionStart(editor);
  updateComposition(editor, "pr123");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual(["/pr-123-review"]);
  });
  updateComposition(editor, "p r123");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual(["/pr-123-review"]);
  });
  expect(editor.textContent).toBe("/p r123");

  for (const key of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
    expect(
      fireEvent.keyDown(editor, { key, isComposing: true, keyCode: 229 }),
    ).toBeTruthy();
    expect(editor.textContent).toBe("/p r123");
    expect(editor).toHaveFocus();
    expect(workflowNames()).toStrictEqual(["/pr-123-review"]);
  }

  // The editor's composition state also protects keys missing the native flag.
  expect(fireEvent.keyDown(editor, { key: "Enter" })).toBeTruthy();
  expect(editor.textContent).toBe("/p r123");
  expect(workflowNames()).toStrictEqual(["/pr-123-review"]);

  // Replacing a candidate can change the query without moving the caret.
  updateComposition(editor, "p r124");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual(["/pr-124-review"]);
  });

  updateComposition(editor, "pr124");
  fireEvent.compositionEnd(editor, { data: "pr124" });
  // Safari can report the confirming Enter after compositionend.
  expect(
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 229 }),
  ).toBeTruthy();
  expect(editor.textContent).toBe("/pr124");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual(["/pr-124-review"]);
  });
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(editor.textContent).toBe("/pr-124-review ");
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
});

test("Clear a cancelled IME query and keep committed spaces as slash boundaries", async () => {
  const user = userEvent.setup({ delay: null });
  const editor = await openComposer();
  await user.click(editor);
  await user.keyboard("/");
  await screen.findByTestId("slash-workflow-menu");
  fireEvent.compositionStart(editor);
  updateComposition(editor, "p r123");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual(["/pr-123-review"]);
  });

  updateComposition(editor, "");
  fireEvent.compositionEnd(editor, { data: "" });
  await waitFor(() => {
    expect(workflowNames()).toContain("/weekly-recap");
  });
  expect(editor.textContent).toBe("/");

  await fill(editor, "/pr123 details");
  expect(editor.textContent).toBe("/pr123 details");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});
