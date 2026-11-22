import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  composerWorkflow,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
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

test("chat-composer-ime-002 cancelling preedit restores the slash menu before committed text closes it", async () => {
  const editor = await draft();
  await userEvent.keyboard("/");
  await within(await screen.findByTestId("slash-workflow-menu")).findByText(
    /weekly-recap/,
  );
  fireEvent.compositionStart(editor);
  fireEvent.compositionUpdate(editor, { data: "p r123" });
  await waitFor(() => {
    const menu = within(screen.getByTestId("slash-workflow-menu"));
    expect(menu.queryByText(/weekly-recap/)).toBeNull();
  });
  fireEvent.compositionUpdate(editor, { data: "" });
  fireEvent.compositionEnd(editor, { data: "" });
  expect(editor).toHaveTextContent(/^\/$/);
  await expect(
    within(await screen.findByTestId("slash-workflow-menu")).findByText(
      /weekly-recap/,
    ),
  ).resolves.toBeInTheDocument();
  await userEvent.keyboard("pr123 details");
  expect(editor).toHaveTextContent(/^\/pr123 details$/);
  await waitFor(() => {
    return expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
});
