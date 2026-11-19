import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  THREAD_ID,
  composerWorkflow,
  createChatComposerHelpers,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";

const context = testContext();
const { mockAgent, mockThread } = createChatComposerHelpers(context);

async function openComposer(): Promise<HTMLElement> {
  mockAgent();
  mockThread();
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [
      composerWorkflow("pr-123-review", "Review PR 123"),
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
  // happy-dom has no CompositionEvent, so the native event carries its data.
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
  await waitFor(() => {
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
});
