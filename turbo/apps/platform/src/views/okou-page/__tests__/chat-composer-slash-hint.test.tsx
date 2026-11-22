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

async function draft() {
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(
      200,
      ["weekly-recap", "pr-123-review"].map((name) => {
        return composerWorkflow(name, null);
      }),
    );
  });
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  await setupPage({ context, path: RUN_PATH });
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
