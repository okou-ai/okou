import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  agentInstructionsContract,
  agentsByIdContract,
} from "@okouai/api-contracts/contracts/agents";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const context = testContext();

function researchAgent() {
  return {
    isDefaultAgent: false,
    agentId: AGENT_ID,
    avatarUrl: null,
    description: "Investigates release risks",
    displayName: "Research Agent",
    modelProviderId: null,
    ownerId: "test-user-123",
    preferPersonalProvider: false,
    selectedModel: null,
    sound: null,
    visibility: "private" as const,
  };
}

function setupInstructionsPage(
  initialContent: string,
  onUpdate?: (content: string) => void,
): Promise<void> {
  let savedContent = initialContent;
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, researchAgent());
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, {
      content: savedContent,
      filename: "AGENTS.md",
    });
  });
  context.mocks.api(agentInstructionsContract.update, ({ body, respond }) => {
    savedContent = body.content;
    onUpdate?.(body.content);
    return respond(200, researchAgent());
  });

  return setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=instructions`,
  });
}

async function instructionsEditor(): Promise<HTMLElement> {
  const editor = await screen.findByLabelText("Instructions editor");
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Expected the instructions editor");
  }
  return editor;
}

test("Discard restores saved instructions and exits editing", async () => {
  await setupInstructionsPage("Review release notes");
  const editor = await instructionsEditor();

  await fill(editor, "Unsaved instructions");
  const unsavedBar = await screen.findByTestId("unsaved-bar");

  click(within(unsavedBar).getByTestId("discard-button"));

  await waitFor(() => {
    expect(screen.getByLabelText("Instructions editor").textContent).toBe(
      "Review release notes",
    );
  });
  expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
});

test("A user can format and save agent instructions", async () => {
  const updates: string[] = [];
  await setupInstructionsPage("Review release notes", (content) => {
    updates.push(content);
  });
  const user = userEvent.setup({ delay: null });

  const editor = await instructionsEditor();
  expect(editor).toHaveTextContent("Review release notes");
  await fill(editor, "Launch risks");
  await user.click(editor);
  await user.keyboard("{Control>}a{/Control}");

  const formattingControls = [
    "Bold",
    "Italic",
    "Strikethrough",
    "Inline code",
    "Heading 1",
    "Heading 2",
    "Heading 3",
    "Bullet list",
    "Ordered list",
    "Blockquote",
  ] as const;
  for (const control of formattingControls) {
    await expect(screen.findByTitle(control)).resolves.toBeEnabled();
  }
  await user.click(screen.getByTitle("Heading 2"));
  expect(editor.querySelector("h2")).toHaveTextContent("Launch risks");

  const unsavedBar = await screen.findByTestId("unsaved-bar");
  click(within(unsavedBar).getByTestId("save-button"));

  await waitFor(() => {
    expect(updates).toHaveLength(1);
  });
  expect(updates[0]).toContain("## Launch risks");
  await waitFor(() => {
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
  });
  await expect(screen.findByText("Instructions saved")).resolves.toBeVisible();
  expect((await instructionsEditor()).querySelector("h2")).toHaveTextContent(
    "Launch risks",
  );
});
