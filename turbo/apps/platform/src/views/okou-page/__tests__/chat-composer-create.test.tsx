import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import {
  IMAGE_MODEL_CONFIGS,
  PUBLIC_IMAGE_MODELS,
} from "@okouai/core/image-model-catalog";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import {
  userModelPreferenceContract,
  type UpdateUserModelPreferenceRequest,
} from "@okouai/api-contracts/contracts/user-model-preference";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  readClipboardItemText,
  readSingleRichClipboardWrite,
} from "./chat-lifecycle-test-helpers.ts";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { openTemplatePicker } from "./chat-composer-template-gallery-test-helpers.ts";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";
import {
  AGENT_ID,
  THREAD_ID,
  composerInlineTemplates,
  context,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
  selectTemplate,
  composerModelTrigger,
} from "./chat-composer-test-helpers.ts";

function setupModels(): void {
  mockAgent();
  mockOrgModelRoutes("claude-fable-5-1");
  mockBillingCapabilities({
    supportByok: true,
    restrictedBuiltInModels: false,
  });
  context.mocks.data.userModelPreference({
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: "gpt-image-2",
    selectedVideoModel: "dreamina-seedance-2-0-260128",
    updatedAt: "2026-09-07T00:00:00.000Z",
  });
}

function button(label: string, container: ParentNode = document): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((item) => {
    return (
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label
    );
  });
  if (!result) {
    throw new Error(`Expected button ${label}`);
  }
  return result;
}

async function setupComposer(enabled = true): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: enabled,
      [FeatureSwitchKey.ComposerTaskChips]: enabled,
    },
  });
  return await findComposerEditor();
}

/** The panel's rows act on mousedown, which only a full pointer sequence fires. */
async function clickPanelRow(label: string, menu: HTMLElement): Promise<void> {
  await userEvent.setup({ delay: null }).click(button(label, menu));
  await closeTemplatePicker();
}

/** The panel row that enters a create mode, and the chip it leaves behind. */
const CREATE_MODE_ROWS = {
  presentation: { row: "Presentation", task: "Presentation" },
  image: { row: "Illustration", task: "Image" },
} as const;

/** The footer chip is the type, and its accessible name is how to leave it. */
function taskChip(task: "Presentation" | "Image"): HTMLElement {
  return button(`Remove ${task}`);
}

/**
 * A panel row opens the template picker as well as entering the mode, and the
 * open dialog covers the composer. Close it to go on reading the composer.
 */
async function closeTemplatePicker(): Promise<void> {
  const dialog = await screen.findByRole("dialog");
  await userEvent.setup({ delay: null }).click(button("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
}

/** Lands the composer on a create mode from an already open slash panel. */
async function enterCreateMode(
  command: keyof typeof CREATE_MODE_ROWS,
  menu: HTMLElement,
): Promise<void> {
  const { row, task } = CREATE_MODE_ROWS[command];
  await clickPanelRow(row, menu);
  await waitFor(() => {
    expect(taskChip(task)).toBeInTheDocument();
  });
}

async function chooseCommand(
  editor: HTMLElement,
  text: string,
  command: keyof typeof CREATE_MODE_ROWS,
): Promise<void> {
  await fill(editor, text);
  await enterCreateMode(
    command,
    await screen.findByTestId("slash-workflow-menu"),
  );
}

test("Create commands stay hidden until enabled", async () => {
  setupModels();
  const editor = await setupComposer(false);
  await fill(editor, "/");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  expect(screen.queryByLabelText("Remove Presentation")).toBeNull();
});

test("A panel row states its task while only the panel's switch is on", async () => {
  setupModels();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
      [FeatureSwitchKey.ComposerTaskChips]: false,
    },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Our launch /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  await clickPanelRow("Presentation", menu);
  // The footer chip is the one control both rollouts share, so it states the
  // type here in the same shape the chip row's own selection leaves behind.
  await waitFor(() => {
    expect(taskChip("Presentation")).toBeInTheDocument();
  });
  expect(
    screen.getByRole("combobox", { name: "Slide count" }),
  ).toHaveTextContent("8–12 slides");
  expect(editor).toHaveTextContent("Our launch");
});

test("The type a slash command selects states the run in the action row", async () => {
  setupModels();
  const editor = await setupComposer();
  await chooseCommand(editor, "Our launch /", "presentation");
  /*
    What a slash command leaves behind is the same composer state a task chip
    is, so it sits in the same row: under the input, beside the connectors and
    the model, rather than in the per-message lane a send clears.
  */
  const control = taskChip("Presentation");
  expect(editor.compareDocumentPosition(control)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(control.compareDocumentPosition(button("Send"))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("Persisted additional info stays out of the message and copied text", async () => {
  setupModels();
  const clipboard = context.mocks.browser.clipboardWrite();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        role: "user",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "additional_info",
              text: "Create a presentation.\nAdditional generation settings.",
            },
            { type: "text", text: "Our launch brief" },
          ],
        },
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerTaskChips]: true },
  });
  const text = await screen.findByText("Our launch brief");
  const message = text.closest<HTMLElement>('[data-role="user"]');
  if (!message) {
    throw new Error("Expected the user message");
  }
  expect(message).toBeVisible();
  expect(message).not.toHaveTextContent("Create");
  expect(message).not.toHaveTextContent("Additional generation settings");
  click(button("Copy message", message));
  const item = await readSingleRichClipboardWrite(clipboard);
  await expect(readClipboardItemText(item, "text/plain")).resolves.toBe(
    "Our launch brief",
  );
});

async function setupQueuedCreateConversation(): Promise<UserMessageDocument[]> {
  setupModels();
  const queued: UserMessageDocument[] = [];
  const runId = crypto.randomUUID();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    activeRunIds: [runId],
    chatEvents: [
      {
        role: "user",
        content: "Review the launch brief",
        runId,
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
    onQueuedEventAppend: (body) => {
      if (body.userMessage) {
        queued.push(body.userMessage);
      }
    },
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
      [FeatureSwitchKey.ComposerTaskChips]: true,
    },
  });
  await screen.findByText("Review the launch brief");
  return queued;
}

async function chooseSlideCount(name: "20–24 slides" | "4–8 slides") {
  click(screen.getByRole("combobox", { name: "Slide count" }));
  click(await screen.findByRole("option", { name }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Slide count" }),
    ).toHaveTextContent(name);
  });
}

test("A queued Create message keeps its intent separate from user-authored text", async () => {
  const queued = await setupQueuedCreateConversation();
  const followupEditor = await findComposerEditor();
  const prompt = "Create a presentation. Keep these words in my message.";
  await chooseCommand(followupEditor, `${prompt} /`, "presentation");
  await chooseSlideCount("20–24 slides");
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(queued).toHaveLength(1);
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create a presentation."),
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 20-24"),
  });
  expect(
    queued[0]?.parts
      .filter((part) => {
        return part.type === "text";
      })
      .map((part) => {
        return part.text;
      })
      .join("")
      .trim(),
  ).toBe(prompt);
  await expect(screen.findByText(prompt)).resolves.toBeVisible();
});

test("Queued Create messages retain their own slide counts", async () => {
  const queued = await setupQueuedCreateConversation();
  const prompt = "A longer presentation";
  await chooseCommand(
    await findComposerEditor(),
    `${prompt} /`,
    "presentation",
  );
  await chooseSlideCount("20–24 slides");
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(queued).toHaveLength(1);
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 20-24"),
  });
  await expect(screen.findByText(prompt)).resolves.toBeVisible();

  await chooseSlideCount("4–8 slides");
  await fill(await findComposerEditor(), "A shorter follow-up");
  click(button("Send"));
  await waitFor(() => {
    expect(queued).toHaveLength(2);
  });
  expect(queued[1]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 4-8"),
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 20-24"),
  });
  await expect(screen.findByText("A shorter follow-up")).resolves.toBeVisible();
});

test("Image mode combines styles and image models while preserving the prompt", async () => {
  setupModels();
  const editor = await setupComposer();
  await chooseCommand(editor, "A quiet garden /", "image");
  expect(button("Add style")).toBeInTheDocument();
  const picker = await screen.findByRole("combobox", { name: "Image models" });
  click(picker);
  const model = PUBLIC_IMAGE_MODELS.find((candidate) => {
    return candidate !== "gpt-image-2";
  });
  if (!model) {
    throw new Error("Expected another public image model");
  }
  click(
    await screen.findByRole("option", {
      name: IMAGE_MODEL_CONFIGS[model].label,
    }),
  );
  await waitFor(() => {
    expect(picker).toHaveTextContent(IMAGE_MODEL_CONFIGS[model].label);
  });
  click(taskChip("Image"));
  await composerModelTrigger("Claude Fable 5.1");
  expect(screen.queryByLabelText("Remove Image")).toBeNull();
  expect(editor).toHaveTextContent("A quiet garden");
});

test("Retry a failed image preference by selecting the displayed model again", async () => {
  setupModels();
  const updates: UpdateUserModelPreferenceRequest[] = [];
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    updates.push(body);
    if (updates.length === 1) {
      return respond(500, {
        error: {
          code: "PREFERENCE_SAVE_FAILED",
          message: "Image preference could not be saved",
        },
      });
    }
    if (body.selectedImageModel === undefined) {
      throw new Error("Expected an explicit image model preference");
    }
    const preference = {
      selectedModel: body.selectedModel,
      serviceTier: body.serviceTier,
      modelSettings: {},
      selectedImageModel: body.selectedImageModel,
      selectedVideoModel: "dreamina-seedance-2-0-260128" as const,
      updatedAt: "2026-09-22T00:00:00.000Z",
    };
    context.mocks.data.userModelPreference(preference);
    return respond(200, preference);
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
      [FeatureSwitchKey.ComposerTaskChips]: true,
      [FeatureSwitchKey.ChatPreference]: false,
    },
  });
  const editor = await findComposerEditor();
  await chooseCommand(editor, "A quiet garden /", "image");
  const picker = await screen.findByRole("combobox", { name: "Image models" });
  expect(picker).toHaveTextContent("GPT Image 2");
  click(picker);
  click(await screen.findByRole("option", { name: "GPT Image 1" }));
  await screen.findByText("Image preference could not be saved");
  expect(picker).toHaveTextContent("GPT Image 1");

  click(picker);
  click(await screen.findByRole("option", { name: "GPT Image 1" }));
  await waitFor(() => {
    expect(updates).toStrictEqual([
      {
        selectedModel: "claude-fable-5-1",
        serviceTier: null,
        selectedImageModel: "gpt-image-1",
      },
      {
        selectedModel: "claude-fable-5-1",
        serviceTier: null,
        selectedImageModel: "gpt-image-1",
      },
    ]);
  });
  expect(picker).toHaveTextContent("GPT Image 1");
});

test("Image mode sends when the model menu is still open", async () => {
  setupModels();
  const user = userEvent.setup({ delay: null });
  const submissions: UserMessageDocument[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      if (body.userMessage) {
        submissions.push(body.userMessage);
      }
    },
  });
  const editor = await setupComposer();
  await chooseCommand(editor, "A quiet garden /", "image");
  await waitFor(() => {
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
  const picker = screen.getByRole("combobox", { name: "Image models" });
  await user.click(picker);
  const modelListbox = await screen.findByRole("listbox");
  expect(modelListbox).toBeInTheDocument();
  const send = button("Send");
  await user.click(send);
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
});

const createTemplateScenarios = [
  {
    mode: "image",
    commandLabel: "Create image",
    pickerLabel: "Add style",
    selectLabel: "Select template",
    previewLabel: "Preview template",
    templates: ILLUSTRATION_TEMPLATE_ITEMS.map((template) => {
      return {
        ...template,
        request: {
          type: "illustration" as const,
          selection: { illustrationStyleId: template.illustrationStyleId },
        },
      };
    }),
  },
  {
    mode: "presentation",
    commandLabel: "Create presentation",
    pickerLabel: "Add template",
    selectLabel: "Select template",
    previewLabel: "Preview template",
    templates: PRESENTATION_TEMPLATE_PICKER_ITEMS.map((template) => {
      return {
        ...template,
        request: {
          type: "presentation" as const,
          selection: {
            templateId: template.templateId,
            colorSystemId: template.colorSystemId ?? undefined,
          },
        },
      };
    }),
  },
] as const;

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
    click(button(pickerLabel));
    await screen.findByRole("dialog");
    click(await screen.findByLabelText(`${selectLabel} ${first.title}`));
    await waitFor(() => {
      expect(composerInlineTemplates()).toHaveLength(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(composerInlineTemplates()[0]).toHaveTextContent(first.title);
    expect(editor).toHaveTextContent("Our launch");
    expect(button(pickerLabel)).toBeInTheDocument();
  },
);

async function setupExistingDraftTemplate(
  scenario: (typeof createTemplateScenarios)[number],
) {
  const { mode, templates } = scenario;
  setupModels();
  mockChatLifecycle(context);
  const [first, second] = templates;
  if (!first || !second) {
    throw new Error(`Expected two ${mode} templates`);
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
        ],
      },
      draftAttachments: null,
    });
  });
  const editor = await setupComposer();
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  await user.paste(" /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  await enterCreateMode(mode, menu);
  return { editor, first, second };
}

test.each(createTemplateScenarios)(
  "$commandLabel adds another template without replacing existing content",
  async (scenario) => {
    const { pickerLabel, selectLabel } = scenario;
    const { editor, first, second } =
      await setupExistingDraftTemplate(scenario);
    click(button(pickerLabel));
    await screen.findByRole("dialog");
    click(await screen.findByLabelText(`${selectLabel} ${second.title}`));
    await waitFor(() => {
      const chips = composerInlineTemplates();
      expect(chips).toHaveLength(2);
      expect(chips[0]).toHaveTextContent(first.title);
      expect(chips[1]).toHaveTextContent(second.title);
    });
    expect(editor).toHaveTextContent("Our launch");
    expect(editor).toHaveTextContent("for the cover.");
    expect(button(pickerLabel)).toBeInTheDocument();
  },
);

async function setupEditedDraftTemplate(
  scenario: (typeof createTemplateScenarios)[number],
) {
  const { mode, pickerLabel, selectLabel, previewLabel, templates } = scenario;
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
  expect(button(pickerLabel)).toBeInTheDocument();
  return { mode, replacement, second, submissions };
}

test.each(createTemplateScenarios)(
  "$commandLabel sends every edited draft template reference",
  async (scenario) => {
    const { mode, replacement, second, submissions } =
      await setupEditedDraftTemplate(scenario);
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
  },
);

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
    expect(button("Add template")).toBeInTheDocument();
  });
  return { first, second, submissions };
}

test("Multiple templates keep a generic toolbar label", async () => {
  await setupMultipleTemplatePresentation();
  expect(composerInlineTemplates()).toHaveLength(2);
});

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
    expect(button("Add template")).toBeInTheDocument();
  });
  expect(composerInlineTemplates()).toHaveLength(1);
  click(button("Add template"));
  await screen.findByRole("dialog");
  click(await screen.findByLabelText(`Select template ${second.title}`));
  await waitFor(() => {
    const chips = composerInlineTemplates();
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent(first.title);
    expect(chips[1]).toHaveTextContent(second.title);
  });
});

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
  click(button("Add style"));
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

test("Create mode preserves slash text and template references", async () => {
  const { editor } = await setupCreateModeWithTemplate();
  expect(editor).toHaveTextContent("Our launch /notes");
});

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

async function setupComposerWithChipCover(
  chipCover: boolean,
): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
      [FeatureSwitchKey.ComposerTaskChips]: true,
      [FeatureSwitchKey.ComposerTemplateChipCover]: chipCover,
    },
  });
  return await findComposerEditor();
}

function inlineTemplateCover(index = 0): HTMLImageElement | null {
  const chip = composerInlineTemplates()[index];
  if (!chip) {
    throw new Error(`Expected an inline template at ${index}`);
  }
  return chip.querySelector("img");
}

async function addPresentationTemplate(
  editor: HTMLElement,
  title: string,
): Promise<void> {
  await chooseCommand(editor, "Our launch /", "presentation");
  click(button("Add template"));
  await screen.findByRole("dialog");
  click(await screen.findByLabelText(`Select template ${title}`));
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
}

test("The template chip cover stays off until the Lab switch is on", async () => {
  setupModels();
  mockChatLifecycle(context);
  const editor = await setupComposerWithChipCover(false);
  const [first] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first) {
    throw new Error("Expected a presentation template");
  }
  await addPresentationTemplate(editor, first.title);
  expect(inlineTemplateCover()).toBeNull();
  expect(composerInlineTemplates()[0]).toHaveTextContent(first.title);
});

async function setupCoveredPresentationTemplate() {
  setupModels();
  mockChatLifecycle(context);
  const editor = await setupComposerWithChipCover(true);
  const [first, , replacement] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first || !replacement) {
    throw new Error("Expected two presentation templates");
  }
  await addPresentationTemplate(editor, first.title);
  return { first, replacement };
}

test("An inline template chip shows the chosen cover", async () => {
  const { first } = await setupCoveredPresentationTemplate();
  await waitFor(() => {
    expect(inlineTemplateCover()?.getAttribute("src")).toContain(first.slug);
  });
});

test("An inline template chip follows a replacement cover", async () => {
  const { first, replacement } = await setupCoveredPresentationTemplate();
  const chip = composerInlineTemplates()[0];
  if (!chip) {
    throw new Error("Expected the inline template");
  }
  click(button(`Preview template ${first.title}`, chip));
  await screen.findByRole("dialog");
  click(await screen.findByLabelText(`Select template ${replacement.title}`));
  await waitFor(() => {
    expect(inlineTemplateCover()?.getAttribute("src")).toContain(
      replacement.slug,
    );
  });
  expect(composerInlineTemplates()).toHaveLength(1);
});

test("A template with no cover keeps the template glyph on its chip", async () => {
  setupModels();
  mockChatLifecycle(context);
  await setupComposerWithChipCover(true);
  const [template] = VIDEO_TEMPLATE_ITEMS;
  if (!template) {
    throw new Error("Expected a video template");
  }
  await openTemplatePicker(userEvent.setup({ delay: null }), "Video");
  click(
    await screen.findByLabelText(`Select video template ${template.title}`),
  );
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
  expect(inlineTemplateCover()).toBeNull();
});
