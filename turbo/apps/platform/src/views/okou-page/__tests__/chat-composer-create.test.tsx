import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import {
  CREATE_MODE_ROWS,
  button,
  chooseCommand,
  clickPanelRow,
  createTemplateScenarios,
  setupComposer,
  setupModels,
  taskChip,
} from "./chat-composer-create-test-helpers.ts";
import {
  composerInlineTemplates,
  context,
  queryComposerModelTrigger,
  selectTemplate,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

test.each(createTemplateScenarios)(
  "$commandLabel adds a template without replacing the existing text",
  async ({ mode, pickerLabel, selectLabel, templates }) => {
    setupModels();
    mockChatLifecycle(context);
    const editor = await setupComposer();
    const [first] = templates;
    if (!first) {
      throw new Error(`Expected a ${mode} template`);
    }
    await chooseCommand(editor, "Our launch /", mode);
    expect(queryComposerModelTrigger("Claude Fable 5.1")).toBeInTheDocument();
    await clickComposerAddMenuItem(pickerLabel);
    await screen.findByRole("dialog");
    click(await screen.findByLabelText(`${selectLabel} ${first.title}`));
    await waitFor(() => {
      expect(composerInlineTemplates()).toHaveLength(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(composerInlineTemplates()[0]).toHaveTextContent(first.title);
    expect(editor).toHaveTextContent("Our launch");
    expect(taskChip(CREATE_MODE_ROWS[mode].task)).toBeInTheDocument();
  },
);

test("The slash panel's Illustration row opens the image style flow", async () => {
  setupModels();
  const editor = await setupComposer();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  await user.keyboard("/");
  const menu = await screen.findByTestId("slash-workflow-menu");
  await clickPanelRow("Illustration", menu);
  await waitFor(() => {
    expect(taskChip("Image")).toBeVisible();
  });
  await clickComposerAddMenuItem("Add style");
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    const tab = queryAllByRoleFast("tab", dialog).find((item) => {
      return item.textContent?.trim() === "Illustration";
    });
    expect(tab).toHaveAttribute("aria-selected", "true");
  });
});

async function setupCreateModeWithTemplate() {
  setupModels();
  const submissions: UserMessageDocument[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      if (body.userMessage) {
        submissions.push(body.userMessage);
      }
    },
  });
  const editor = await setupComposer();
  const user = userEvent.setup({ delay: null });
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  await selectTemplate(template);
  await user.click(editor);
  await user.paste("Our launch /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  expect(submissions).toHaveLength(0);
  await clickPanelRow("Presentation", menu);
  const chip = await waitFor(() => {
    return taskChip("Presentation");
  });
  expect(menu).not.toBeInTheDocument();
  expect(editor).toHaveTextContent("Our launch");
  expect(composerInlineTemplates()).toHaveLength(1);
  await user.paste(" /notes");
  await waitFor(() => {
    expect(editor).toHaveFocus();
  });
  expect(editor).toHaveTextContent("Our launch /notes");
  expect(composerInlineTemplates()).toHaveLength(1);
  return { chip, editor, submissions, template };
}

test("Exiting Create mode sends the ordinary draft and template", async () => {
  const { chip, editor, submissions, template } =
    await setupCreateModeWithTemplate();
  click(chip);
  await waitFor(() => {
    expect(chip).not.toBeInTheDocument();
  });
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent("Our launch /notes");
  expect(composerInlineTemplates()).toHaveLength(1);
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(JSON.stringify(submissions[0])).toContain("Our launch");
  expect(submissions[0]?.parts).not.toContainEqual(
    expect.objectContaining({ type: "additional_info" }),
  );
  expect(submissions[0]?.parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      titleSnapshot: template.title,
    }),
  );
});
