import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  composerWorkflow,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

async function draft(path = RUN_PATH) {
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(
      200,
      ["weekly-recap", "pr-123-review"].map((name) => {
        return composerWorkflow(name, null);
      }),
    );
  });
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  await setupPage({ context, path });
  const editor = await findComposerEditor();
  await userEvent.click(editor);
  return editor;
}

test("chat-composer-slash-hint-002 the workflow hint follows a bare slash in the existing thread", async () => {
  const editor = await draft();
  await userEvent.keyboard("/");
  await screen.findByTestId("slash-workflow-menu");
  const hint = () => {
    return editor.querySelector("[data-placeholder]");
  };
  expect(hint()).toBeInTheDocument();
  expect(editor).toHaveTextContent(/^\/$/);
  await userEvent.keyboard("week");
  const menu = await screen.findByTestId("slash-workflow-menu");
  expect(hint()).toBeNull();
  click(await findFastControl("button", /weekly-recap/, menu));
  expect(editor).toHaveTextContent("weekly-recap");
  await userEvent.keyboard(" /");
  await screen.findByTestId("slash-workflow-menu");
  const before = editor.textContent;
  expect(hint()).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(hint()).toBeNull();
  expect(editor.textContent).toBe(before);
  expect(editor).toHaveFocus();
});

test("The home composer dismisses a second bare slash hint while preserving the accepted workflow", async () => {
  const editor = await draft("/");
  await userEvent.keyboard("/");
  const firstMenu = await screen.findByTestId("slash-workflow-menu");
  expect(editor.textContent).toBe("/");
  expect(editor.querySelector("[data-placeholder]")).toBeInTheDocument();
  await userEvent.keyboard("pr");
  const choice = await findFastControl("button", /pr-123-review/, firstMenu);
  expect(editor.querySelector("[data-placeholder]")).toBeNull();
  expect(choice).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(editor).toHaveTextContent("pr-123-review");
  await userEvent.keyboard(" /");
  await screen.findByTestId("slash-workflow-menu");
  const accepted = editor.textContent;
  expect(editor.querySelector("[data-placeholder]")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  expect(editor.querySelector("[data-placeholder]")).toBeNull();
  expect(editor.textContent).toBe(accepted);
  expect(editor).toHaveFocus();
});

test("A home workflow inserted at the beginning keeps the numbered suffix after its hint", async () => {
  const editor = await draft("/");
  await userEvent.keyboard(" 131");
  expect(editor.textContent).toBe(" 131");
  const cursor = window.getSelection();
  cursor?.collapse(editor.querySelector("p")?.firstChild ?? editor, 0);
  await userEvent.keyboard("/");
  const panel = await screen.findByTestId("slash-workflow-menu");
  const hint = editor.querySelector("[data-placeholder]");
  expect(hint?.textContent).toBe("/");
  expect(hint?.nextSibling?.textContent).toBe(" 131");
  expect(editor.textContent).toBe("/ 131");
  await userEvent.keyboard("week");
  expect(editor.textContent).toBe("/week 131");
  click(await findFastControl("button", /weekly-recap/, panel));
  expect(editor).toHaveTextContent("weekly-recap");
  expect(editor.textContent).toBe("/weekly-recap 131");
});
