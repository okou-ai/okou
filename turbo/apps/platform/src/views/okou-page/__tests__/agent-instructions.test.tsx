import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  agentInstructionsContract,
  agentsByIdContract,
} from "@okouai/api-contracts/contracts/agents";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
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

test("Markdown links load as editable instruction text", async () => {
  await setupInstructionsPage(
    "Review the [Runbook](https://docs.example.test/runbook) before launch.",
  );

  const editor = await instructionsEditor();
  expect(editor).toHaveTextContent("Review the Runbook before launch.");
  expect(editor.querySelector("a")).toBeNull();

  await userEvent.setup({ delay: null }).click(editor);

  expect(editor).toHaveFocus();
  expect(pathname()).toBe(`/agents/${AGENT_ID}`);
});

test.each([
  { name: "saved instructions", initialContent: "Review release notes" },
  { name: "empty instructions", initialContent: "" },
])("Discard restores $name and exits editing", async ({ initialContent }) => {
  await setupInstructionsPage(initialContent);
  const user = userEvent.setup({ delay: null });
  const editor = await instructionsEditor();

  await fill(editor, "Unsaved instructions");
  await user.click(editor);
  expect(editor).toHaveFocus();
  const unsavedBar = await screen.findByTestId("unsaved-bar");

  click(within(unsavedBar).getByTestId("discard-button"));

  await waitFor(() => {
    expect(screen.getByLabelText("Instructions editor").textContent).toBe(
      initialContent,
    );
  });
  const restoredEditor = await instructionsEditor();
  expect(restoredEditor).not.toHaveFocus();
  expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();

  await user.click(restoredEditor);
  await user.keyboard("{Control>}z{/Control}");

  expect(restoredEditor.textContent).toBe(initialContent);
  expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();

  await fill(restoredEditor, "A fresh edit");
  const nextUnsavedBar = await screen.findByTestId("unsaved-bar");

  click(within(nextUnsavedBar).getByTestId("discard-button"));

  await waitFor(() => {
    expect(screen.getByLabelText("Instructions editor").textContent).toBe(
      initialContent,
    );
  });
  expect(screen.getByLabelText("Instructions editor")).not.toHaveFocus();
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

  await fill(await instructionsEditor(), "An unsaved replacement");
  const nextUnsavedBar = await screen.findByTestId("unsaved-bar");

  click(within(nextUnsavedBar).getByTestId("discard-button"));

  await waitFor(() => {
    expect(
      screen.getByLabelText("Instructions editor").querySelector("h2"),
    ).toHaveTextContent("Launch risks");
  });
  expect(screen.getByLabelText("Instructions editor")).not.toHaveFocus();
  expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
});

test.each(["{Enter}", " "])(
  "Activate instruction formatting with %s after cancelling a pointer press",
  async (key) => {
    await setupInstructionsPage("Selected instructions");
    const user = userEvent.setup({ delay: null });
    const editor = await instructionsEditor();
    await user.click(editor);
    await user.keyboard("{Control>}a{/Control}");
    const bold = await screen.findByTitle("Bold");

    await user.pointer({ target: bold, keys: "[MouseLeft>]" });
    expect(bold).toHaveFocus();
    expect(editor).toHaveTextContent("Selected instructions");
    expect(editor.querySelector("strong")).toBeNull();
    await user.pointer({ target: editor, keys: "[/MouseLeft]" });
    await user.pointer({ target: bold, keys: "[MouseRight]" });
    expect(editor.querySelector("strong")).toBeNull();

    await user.keyboard(key);
    await waitFor(() => {
      expect(editor.querySelector("strong")).toHaveTextContent(
        "Selected instructions",
      );
      expect(editor).toHaveFocus();
    });
    expect(window.getSelection()?.toString()).toBe("Selected instructions");
    // user-event keyboard insertion replaces a selected DOM range with a bare
    // text node. Paste exercises ProseMirror's rich-text replacement instead.
    await user.paste("Replacement");
    expect(editor.querySelector("strong")).toHaveTextContent("Replacement");
    expect(editor).not.toHaveTextContent("Selected instructions");
  },
);
