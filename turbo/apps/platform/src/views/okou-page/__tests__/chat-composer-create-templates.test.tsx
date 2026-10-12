import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import {
  CREATE_MODE_ROWS,
  button,
  clickPanelRow,
  createTemplateScenarios,
  enterCreateMode,
  setupComposer,
  setupModels,
  taskChip,
} from "./chat-composer-create-test-helpers.ts";
import {
  composerInlineTemplates,
  context,
  findComposerEditor,
  selectTemplate,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

async function setupEditedDraftTemplate(
  scenario: (typeof createTemplateScenarios)[number],
) {
  const { mode, selectLabel, previewLabel, templates } = scenario;
  setupModels();
  const submissions: UserMessageDocument[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      if (body.userMessage) {
        submissions.push(body.userMessage);
      }
    },
  });
  const [first, second, replacement] = templates;
  if (!first || !second || !replacement) {
    throw new Error(`Expected three ${mode} templates`);
  }
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Our launch " },
          {
            type: "template",
            titleSnapshot: first.title,
            template: first.request,
          },
          { type: "text", text: " for the cover. " },
          {
            type: "template",
            titleSnapshot: second.title,
            template: second.request,
          },
        ],
      },
      draftAttachments: null,
    });
  });
  const editor = await setupComposer();
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(2);
  });
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  await user.paste(" /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  await enterCreateMode(mode, menu);

  const firstChip = composerInlineTemplates()[0];
  if (!firstChip) {
    throw new Error("Expected the first inline template");
  }
  click(button(`${previewLabel} ${first.title}`, firstChip));
  await screen.findByRole("dialog");
  click(await screen.findByLabelText(`${selectLabel} ${replacement.title}`));
  await waitFor(() => {
    const chips = composerInlineTemplates();
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent(replacement.title);
    expect(chips[1]).toHaveTextContent(second.title);
  });
  expect(editor).toHaveTextContent("Our launch");
  expect(editor).toHaveTextContent("for the cover.");
  expect(taskChip(CREATE_MODE_ROWS[mode].task)).toBeInTheDocument();
  return { mode, replacement, second, submissions };
}

test("Create image sends every edited draft template reference", async () => {
  const { mode, replacement, second, submissions } =
    await setupEditedDraftTemplate(createTemplateScenarios[0]);
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  const parts = submissions[0]?.parts;
  expect(parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining(
      `Create ${mode === "image" ? "an" : "a"} ${mode}.`,
    ),
  });
  expect(
    parts?.flatMap((part) => {
      return part.type === "template" ? [part.titleSnapshot] : [];
    }),
  ).toStrictEqual([replacement.title, second.title]);
  expect(JSON.stringify(parts)).toContain("Our launch");
  expect(JSON.stringify(parts)).toContain("for the cover.");
});

async function setupMultipleTemplatePresentation() {
  setupModels();
  const submissions: UserMessageDocument[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      if (body.userMessage) {
        submissions.push(body.userMessage);
      }
    },
  });
  await setupComposer();
  const user = userEvent.setup({ delay: null });
  const [first, second] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first || !second) {
    throw new Error("Expected two presentation templates");
  }
  await selectTemplate(first);
  await selectTemplate(second);
  // Page bootstrap can remount the editor while the template dialogs are open.
  await user.click(await findComposerEditor());
  await user.paste(" /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  await clickPanelRow("Presentation", menu);
  await waitFor(() => {
    expect(taskChip("Presentation")).toBeInTheDocument();
  });
  return { first, second, submissions };
}

test("All selected template references survive sending", async () => {
  const { first, second, submissions } =
    await setupMultipleTemplatePresentation();
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(
    submissions[0]?.parts
      .filter((part) => {
        return part.type === "template";
      })
      .map((part) => {
        return part.titleSnapshot;
      }),
  ).toStrictEqual([first.title, second.title]);
});

test("Presentation adds another template when the draft already has one", async () => {
  setupModels();
  const editor = await setupComposer();
  const user = userEvent.setup({ delay: null });
  const [first, second] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first || !second) {
    throw new Error("Expected two presentation templates");
  }
  await selectTemplate(first);
  await user.click(editor);
  await user.paste(" /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  await clickPanelRow("Presentation", menu);
  await waitFor(() => {
    expect(taskChip("Presentation")).toBeInTheDocument();
  });
  expect(composerInlineTemplates()).toHaveLength(1);
  await clickComposerAddMenuItem("Add template");
  await screen.findByRole("dialog");
  click(await screen.findByLabelText(`Select template ${second.title}`));
  await waitFor(() => {
    const chips = composerInlineTemplates();
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent(first.title);
    expect(chips[1]).toHaveTextContent(second.title);
  });
});
