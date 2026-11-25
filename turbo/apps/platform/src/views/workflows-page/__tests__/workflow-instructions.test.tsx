import { workflowsDetailContract } from "@okouai/api-contracts/contracts/workflows";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import { salesWorkflow, serveWorkflows } from "./workflow-boundary.ts";

const context = testContext();

test.each([
  ["workflow-instructions-003", "Workflow instruction", ""],
  ["workflow-instructions-004", "Workflow file content", "?file=notes.md"],
])(
  "%s preserves the editable draft after a conflict and saves it on retry",
  async (_id, label, query) => {
    const work = salesWorkflow(context);
    serveWorkflows(context, () => {
      return [work];
    });
    let conflict = true;
    const value = "Verify the Q4 figures";
    context.mocks.api(workflowsDetailContract.update, ({ body, respond }) => {
      if (conflict) {
        return respond(409, {
          error: { code: "CONFLICT", message: "Revision conflict" },
        });
      }
      if (query) {
        work.fileContents = body.files ?? [];
      } else {
        work.instruction = body.instruction ?? null;
      }
      return respond(200, work);
    });
    await setupPage({
      context,
      path: "/workflows/" + work.id + "/instructions" + query,
    });
    await fill(await screen.findByLabelText(label), value);
    await screen.findByText("You have unsaved changes");
    click(await findAction("button", "Save"));
    await screen.findByText("Revision conflict");
    expect(screen.getByLabelText(label)).toHaveTextContent(value);
    expect(screen.getByText("You have unsaved changes")).toBeVisible();
    const retry = await findAction("button", "Save");
    expect(retry).toBeEnabled();
    conflict = false;
    click(retry);
    await waitFor(() => {
      return expect(screen.queryByText("You have unsaved changes")).toBeNull();
    });
    expect(screen.getByLabelText(label)).toHaveTextContent(value);
    const persisted = query
      ? work.fileContents?.find((file) => {
          return file.path === "notes.md";
        })?.content
      : work.instruction;
    expect(persisted).toBe(value);
  },
);

test("workflow-instructions-006 a discarded notes edit cannot be restored by undo", async () => {
  const work = salesWorkflow(context);
  serveWorkflows(context, () => {
    return [work];
  });
  await setupPage({
    context,
    path: "/workflows/" + work.id + "/instructions?file=notes.md",
  });
  const label = "Workflow file content";
  await fill(await screen.findByLabelText(label), "Unpublished notes");
  click(await findAction("button", "Discard"));
  await screen.findByText("Keep notes");
  await userEvent.click(screen.getByLabelText(label));
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(screen.getByLabelText(label)).toHaveTextContent("Keep notes");
  expect(screen.queryByText("You have unsaved changes")).toBeNull();
  await fill(screen.getByLabelText(label), "Replacement notes");
  await expect(
    screen.findByText("You have unsaved changes"),
  ).resolves.toBeVisible();
});
