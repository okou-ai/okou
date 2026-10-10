import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  workflowsDetailContract,
  type WorkflowDetailResponse,
} from "@okouai/api-contracts/contracts/workflows";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const WORKFLOW_ID = "d0000000-0000-4000-a000-000000000098";

function workflow(): WorkflowDetailResponse {
  return {
    id: WORKFLOW_ID,
    agentId: "c0000000-0000-4000-a000-000000000001",
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "release-review",
    displayName: "Release Review",
    description: "Review release risks.",
    visibility: "private",
    official: null,
    ownerUserId: "test-user-123",
    canManage: true,
    canPublish: false,
    importSource: null,
    createdByUserId: "test-user-123",
    updatedByUserId: "test-user-123",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    instruction: "Review release notes",
    files: [{ path: "notes.md", size: 20 }],
    fileContents: [{ path: "notes.md", content: "Review release notes" }],
    automations: [],
  };
}

test.each([
  { name: "instructions", query: "", label: "Workflow instruction" },
  {
    name: "Markdown file",
    query: "?file=notes.md",
    label: "Workflow file content",
  },
])(
  "Discard restores $name and clears the discarded undo history",
  async ({ query, label }) => {
    context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
      return respond(200, workflow());
    });
    await setupPage({
      context,
      path: `/workflows/${WORKFLOW_ID}/instructions${query}`,
    });
    const editor = await screen.findByLabelText(label);
    await fill(editor, "Unsaved release draft");
    const unsavedBar = await screen.findByTestId("unsaved-bar");

    click(within(unsavedBar).getByTestId("discard-button"));

    await waitFor(() => {
      expect(screen.getByLabelText(label)).toHaveTextContent(
        "Review release notes",
      );
    });
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByLabelText(label));
    await user.keyboard("{Control>}z{/Control}");
    expect(screen.getByLabelText(label)).toHaveTextContent(
      "Review release notes",
    );
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();

    await fill(screen.getByLabelText(label), "Another release draft");
    await expect(
      screen.findByTestId("unsaved-bar"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText(label)).toHaveTextContent(
      "Another release draft",
    );
  },
);
