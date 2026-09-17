import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import {
  IMAGE_MODEL_CONFIGS,
  PUBLIC_IMAGE_MODELS,
} from "@okouai/core/image-model-catalog";
import type {
  UserMessageDocument,
  ChatRunOptionsRequest,
} from "@okouai/api-contracts/contracts/chat-threads";
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
    featureSwitches: { [FeatureSwitchKey.ComposerSlashTemplatePanel]: enabled },
  });
  return await findComposerEditor();
}

/** The panel's rows act on mousedown, which only a full pointer sequence fires. */
async function clickPanelRow(label: string, menu: HTMLElement): Promise<void> {
  await userEvent.setup({ delay: null }).click(button(label, menu));
  await closeTemplatePicker();
}

/** The panel row that enters a create mode, and the mode it lands in. */
const CREATE_MODE_ROWS = {
  presentation: { row: "Presentation", mode: "Create presentation" },
  image: { row: "Illustration", mode: "Create image" },
  video: { row: "Video", mode: "Create video" },
} as const;

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

async function chooseCommand(
  editor: HTMLElement,
  text: string,
  command: keyof typeof CREATE_MODE_ROWS,
): Promise<void> {
  const { row, mode } = CREATE_MODE_ROWS[command];
  await fill(editor, text);
  const menu = await screen.findByTestId("slash-workflow-menu");
  await clickPanelRow(row, menu);
  await waitFor(() => {
    expect(screen.getByTestId("composer-create-mode")).toHaveTextContent(mode);
  });
}

test("Create commands stay hidden until enabled", async () => {
  setupModels();
  const editor = await setupComposer(false);
  await fill(editor, "/");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  expect(screen.queryByTestId("composer-create-mode")).toBeNull();
});

test("The type a slash command selects states the run in the action row", async () => {
  setupModels();
  const editor = await setupComposer();
  await chooseCommand(editor, "Our launch /", "video");
  /*
    What a slash command leaves behind is the same composer state a task chip
    is, so it sits in the same row: under the input, beside the connectors and
    the model, rather than in the per-message lane a send clears.
  */
  const control = screen.getByTestId("composer-create-mode");
  expect(editor.compareDocumentPosition(control)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(control.compareDocumentPosition(button("Send"))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("Choose a video from the slash panel with the keyboard and submit its settings", async () => {
  setupModels();
  const submissions: {
    userMessage?: UserMessageDocument;
    runOptions?: ChatRunOptionsRequest;
  }[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      submissions.push(body);
    },
  });
  const editor = await setupComposer();
  const user = userEvent.setup({ delay: null });
  await fill(editor, "A train crossing the mountains /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  expect(button("Video", menu)).toBeInTheDocument();
  // Presentation leads the panel's Make rows, so Video is the third.
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  await closeTemplatePicker();
  await waitFor(() => {
    expect(screen.getByTestId("composer-create-mode")).toHaveTextContent(
      "Create video",
    );
  });
  expect(menu).not.toBeInTheDocument();
  const card = editor.closest('[data-slot="chat-composer-card"]');
  expect(card).toContainElement(
    screen.getByRole("combobox", { name: "Choose a type" }),
  );
  expect(editor).toHaveTextContent("A train crossing the mountains");
  expect(editor).not.toHaveTextContent("/");
  expect(submissions).toHaveLength(0);
  const videoPicker = await screen.findByRole("combobox", {
    name: "Video models",
  });
  expect(videoPicker).toHaveTextContent("Seedance 2.0");
  click(
    await waitFor(() => {
      return button("Video options 16:9 · 8s · 720p");
    }),
  );
  const ratios = await screen.findByRole("radiogroup", { name: "Ratio" });
  const portrait = queryAllByRoleFast("radio", ratios).find((radio) => {
    return radio.textContent?.trim() === "9:16";
  });
  if (!portrait) {
    throw new Error("Portrait ratio missing");
  }
  click(portrait);
  expect(portrait).toHaveAttribute("aria-checked", "true");
  await user.keyboard("{Escape}");
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  const sent = submissions[0];
  expect(sent?.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/^A train crossing the mountains\s*$/),
      }),
      {
        type: "additional_info",
        text: expect.stringContaining("Create a video."),
      },
    ]),
  );
  expect(JSON.stringify(sent?.userMessage)).toContain(
    "A train crossing the mountains",
  );
  expect(sent?.userMessage?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Aspect ratio: 9:16"),
  });
  expect(sent?.runOptions).toBeUndefined();
  await expect(
    screen.findByText("A train crossing the mountains"),
  ).resolves.toBeVisible();
});

test.each(["presentation", "video", "image"] as const)(
  "Persisted %s additional info stays out of the message and copied text",
  async (mode) => {
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
                text: `Create ${mode === "image" ? "an" : "a"} ${mode}.\nAdditional generation settings.`,
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
      featureSwitches: { [FeatureSwitchKey.ComposerSlashTemplatePanel]: true },
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
  },
);

test("A queued Create message keeps its intent separate from user-authored text", async () => {
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
    featureSwitches: { [FeatureSwitchKey.ComposerSlashTemplatePanel]: true },
  });
  await screen.findByText("Review the launch brief");

  const followupEditor = await findComposerEditor();
  const prompt = "Create a presentation. Keep these words in my message.";
  await chooseCommand(followupEditor, `${prompt} /`, "presentation");
  click(screen.getByRole("combobox", { name: "Slide count" }));
  click(await screen.findByRole("option", { name: "20–24 slides" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Slide count" }),
    ).toHaveTextContent("20–24 slides");
  });
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
  click(screen.getByRole("combobox", { name: "Slide count" }));
  click(await screen.findByRole("option", { name: "4–8 slides" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Slide count" }),
    ).toHaveTextContent("4–8 slides");
  });
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
  click(button("Exit create mode"));
  await composerModelTrigger("Claude Fable 5.1");
  expect(screen.queryByTestId("composer-create-mode")).toBeNull();
  expect(editor).toHaveTextContent("A quiet garden");
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
    mode: "video",
    commandLabel: "Create video",
    pickerLabel: "Add template",
    selectLabel: "Select video template",
    previewLabel: "Preview video template",
    templates: VIDEO_TEMPLATE_ITEMS.map((template) => {
      return {
        ...template,
        request: {
          type: "video" as const,
          selection: { stylePresetId: template.id },
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
  "$commandLabel adds multiple templates without replacing the existing text or chip",
  async ({ mode, pickerLabel, selectLabel, templates }) => {
    setupModels();
    mockChatLifecycle(context);
    const editor = await setupComposer();
    const user = userEvent.setup({ delay: null });
    const [first, second] = templates;
    if (!first || !second) {
      throw new Error(`Expected two ${mode} templates`);
    }
    await chooseCommand(editor, "Our launch /", mode);
    click(button(pickerLabel));
    await screen.findByRole("dialog");
    click(await screen.findByLabelText(`${selectLabel} ${first.title}`));
    await waitFor(() => {
      expect(composerInlineTemplates()).toHaveLength(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await user.paste(" for the cover. ");
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

test.each(createTemplateScenarios)(
  "$commandLabel edits only the clicked draft template and sends every reference",
  async ({
    mode,
    commandLabel,
    pickerLabel,
    selectLabel,
    previewLabel,
    templates,
  }) => {
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
    await clickPanelRow(CREATE_MODE_ROWS[mode].row, menu);
    await waitFor(() => {
      expect(screen.getByTestId("composer-create-mode")).toHaveTextContent(
        commandLabel,
      );
    });

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

test("Multiple templates keep a generic toolbar label and all references survive sending", async () => {
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
  expect(composerInlineTemplates()).toHaveLength(2);
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
    expect(screen.getByTestId("composer-create-mode")).toHaveTextContent(
      "Create image",
    );
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

test("Switching Create preserves slash text and template references", async () => {
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
  const chip = await screen.findByTestId("composer-create-mode");
  expect(chip).toHaveTextContent("Create presentation");
  expect(menu).not.toBeInTheDocument();
  expect(editor).toHaveTextContent("Our launch");
  expect(composerInlineTemplates()).toHaveLength(1);
  await user.paste(" /notes");
  click(screen.getByRole("combobox", { name: "Choose a type" }));
  click(await screen.findByRole("option", { name: "Image" }));
  await waitFor(() => {
    expect(chip).toHaveTextContent("Create image");
    expect(editor).toHaveFocus();
  });
  expect(editor).toHaveTextContent("Our launch /notes");
  expect(composerInlineTemplates()).toHaveLength(1);
  click(button("Exit create mode", chip));
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

test("An inline template chip shows the chosen cover and follows a replacement", async () => {
  setupModels();
  mockChatLifecycle(context);
  const editor = await setupComposerWithChipCover(true);
  const [first, , replacement] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first || !replacement) {
    throw new Error("Expected two presentation templates");
  }
  await addPresentationTemplate(editor, first.title);
  await waitFor(() => {
    expect(inlineTemplateCover()?.getAttribute("src")).toContain(first.slug);
  });

  // The picker rewrites the node in place, so the cover has to follow the new
  // selection rather than only the first one.
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
  const editor = await setupComposerWithChipCover(true);
  const [template] = VIDEO_TEMPLATE_ITEMS;
  if (!template) {
    throw new Error("Expected a video template");
  }
  await chooseCommand(editor, "Our launch /", "video");
  click(button("Add template"));
  await screen.findByRole("dialog");
  click(
    await screen.findByLabelText(`Select video template ${template.title}`),
  );
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
  expect(inlineTemplateCover()).toBeNull();
});

test("Reopening and dismissing the in-composer picker preserves the selected scene and draft", async () => {
  setupModels();
  const editor = await setupComposer();
  const user = userEvent.setup({ delay: null });
  await chooseCommand(editor, "Our quarterly update /", "presentation");
  const trigger = screen.getByRole("combobox", { name: "Choose a type" });
  const card = editor.closest('[data-slot="chat-composer-card"]');
  expect(card).toContainElement(trigger);
  expect(editor).toBeVisible();

  click(screen.getByRole("combobox", { name: "Slide count" }));
  click(await screen.findByRole("option", { name: "16–20 slides" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Slide count" }),
    ).toHaveTextContent("16–20 slides");
  });
  click(trigger);
  const picker = await screen.findByRole("listbox", { name: "Choose a type" });
  expect(card).toContainElement(picker);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(trigger).toHaveAttribute("aria-controls", picker.id);
  expect(
    within(picker).getByRole("option", { name: "Presentation" }),
  ).toHaveAttribute("aria-selected", "true");
  expect(button("Send")).toBeDisabled();
  await user.keyboard("{ArrowDown}{Escape}");
  await waitFor(() => {
    expect(editor).toHaveFocus();
  });
  expect(picker).not.toBeInTheDocument();
  expect(trigger).toHaveTextContent("Create presentation");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(editor).toHaveTextContent("Our quarterly update");
  expect(
    screen.getByRole("combobox", { name: "Slide count" }),
  ).toHaveTextContent("16–20 slides");

  click(trigger);
  const reopened = await screen.findByRole("listbox", {
    name: "Choose a type",
  });
  click(within(reopened).getByRole("option", { name: "Image" }));
  await waitFor(() => {
    expect(editor).toHaveFocus();
  });
  expect(trigger).toHaveTextContent("Create image");
  expect(editor).toHaveTextContent("Our quarterly update");
  expect(editor).toBeVisible();
  expect(reopened).not.toBeInTheDocument();
});
