import {
  readClipboardItemText,
  readSingleRichClipboardWrite,
} from "./chat-clipboard-test-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { composerDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { openTemplatePicker } from "./chat-composer-template-gallery-test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import {
  AGENT_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  THREAD_ID,
  composerInlineTemplates,
  findComposerEditor,
  queryComposerModelTrigger,
  createChatComposerHelpers,
} from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const { mockAgent, mockBillingCapabilities, mockPersonalModelRoutes } =
  createChatComposerHelpers(context);

function setupModels(): void {
  mockAgent();
  mockPersonalModelRoutes();
  context.mocks.data.availableRunModels([
    buildRunModel({
      model: "claude-fable-5-1",
      modelLabel: "Claude Fable 5.1",
      providerType: "claude-code-oauth-token",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
  ]);
  mockBillingCapabilities({ restrictedBuiltInModels: false });
  context.mocks.data.userModelPreference({
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
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

async function setupComposer(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  return await findComposerEditor();
}

function taskChip(task: "Presentation" | "Image"): HTMLElement {
  return button(`Remove ${task}`);
}

async function enterCreateMode(
  task: "Presentation" | "Image",
  fromMenu = false,
): Promise<void> {
  if (fromMenu) {
    await clickComposerAddMenuItem("Create");
  } else {
    const cards = await screen.findByRole("group", {
      name: "Explore Okou capabilities",
    });
    const create = within(cards).getByRole("region", { name: "Create" });
    click(button("Presentation", create));
  }
  const types = await screen.findByRole("radiogroup", { name: "Create" });
  const choice = queryAllByRoleFast("radio", types).find((item) => {
    return item.textContent?.trim() === task;
  });
  if (!choice) {
    throw new Error(`Expected creation type ${task}`);
  }
  click(choice);
  await waitFor(() => {
    expect(taskChip(task)).toBeInTheDocument();
  });
}

async function openCreationCatalog(task: "Presentation" | "Image") {
  await enterCreateMode(task);
  click(button("View all", screen.getByRole("tabpanel")));
  return await screen.findByRole("dialog");
}

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
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
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
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
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
  await enterCreateMode("Presentation", true);
  await fill(followupEditor, prompt);
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
  await expect(screen.findByText(prompt)).resolves.toBeInTheDocument();
});

const createTemplateScenarios = [
  {
    mode: "image",
    task: "Image",
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
    task: "Presentation",
    selectLabel: "Select template",
    previewLabel: "Preview template",
    templates: PRESENTATION_TEMPLATE_PICKER_ITEMS.map((template) => {
      return {
        ...template,
        request: {
          type: "presentation" as const,
          selection: {
            templateId: template.templateId,
            colorSystemId: template.colorSystemId,
          },
        },
      };
    }),
  },
] as const;

test.each(createTemplateScenarios)(
  "$task adds a template without replacing the existing text",
  async ({ mode, task, selectLabel, templates }) => {
    setupModels();
    mockChatLifecycle(context);
    const editor = await setupComposer();
    const [first] = templates;
    if (!first) {
      throw new Error(`Expected a ${mode} template`);
    }
    await fill(editor, "Our launch");
    const dialog = await openCreationCatalog(task);
    click(
      await within(dialog).findByLabelText(`${selectLabel} ${first.title}`),
    );
    await waitFor(() => {
      expect(composerInlineTemplates()).toHaveLength(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(composerInlineTemplates()[0]).toHaveTextContent(first.title);
    expect(queryComposerModelTrigger("Claude Fable 5.1")).toBeInTheDocument();
    expect(editor).toHaveTextContent("Our launch");
    expect(taskChip(task)).toBeInTheDocument();
  },
);

async function setupEditedDraftTemplate(
  scenario: (typeof createTemplateScenarios)[number],
) {
  const { mode, task, selectLabel, previewLabel, templates } = scenario;
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
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
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
  await enterCreateMode(task);
  const firstChip = composerInlineTemplates()[0];
  if (!firstChip) {
    throw new Error("Expected the first inline template");
  }
  click(button(`${previewLabel} ${first.title}`, firstChip));
  const dialog = await screen.findByRole("dialog");
  click(
    await within(dialog).findByLabelText(`${selectLabel} ${replacement.title}`),
  );
  await waitFor(() => {
    const chips = composerInlineTemplates();
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent(replacement.title);
    expect(chips[1]).toHaveTextContent(second.title);
  });
  expect(editor).toHaveTextContent("Our launch");
  expect(editor).toHaveTextContent("for the cover.");
  expect(taskChip(task)).toBeInTheDocument();
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

async function setupSavedPresentationDraft() {
  setupModels();
  const [first, second] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first || !second) {
    throw new Error("Expected two presentation templates");
  }
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          {
            type: "template",
            titleSnapshot: first.title,
            template: {
              type: "presentation",
              selection: { templateId: first.templateId },
            },
          },
        ],
      },
      draftAttachments: null,
    });
  });
  const editor = await setupComposer();
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent(first.title);
  });
  return { editor, first, second };
}

test("Entering Presentation preserves an existing draft template", async () => {
  const { first } = await setupSavedPresentationDraft();
  await enterCreateMode("Presentation");
  expect(taskChip("Presentation")).toBeInTheDocument();
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent(first.title);
});

test("Presentation adds another template when the draft already has one", async () => {
  const { first, second } = await setupSavedPresentationDraft();
  await enterCreateMode("Presentation");
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

test("Image mode opens its style picker from the Add menu", async () => {
  setupModels();
  await setupComposer();
  await enterCreateMode("Image");
  await clickComposerAddMenuItem("Add style");
  const dialog = await screen.findByRole("dialog");
  const tab = queryAllByRoleFast("tab", dialog).find((item) => {
    return item.textContent?.trim() === "Image";
  });
  expect(tab).toHaveAttribute("aria-selected", "true");
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
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Our launch /notes " },
          {
            type: "template",
            titleSnapshot: template.title,
            template: {
              type: "presentation",
              selection: { templateId: template.templateId },
            },
          },
        ],
      },
      draftAttachments: null,
    });
  });
  const editor = await setupComposer();
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
  expect(submissions).toHaveLength(0);
  await enterCreateMode("Presentation");
  const chip = taskChip("Presentation");
  expect(editor).toHaveTextContent("Our launch /notes");
  expect(composerInlineTemplates()).toHaveLength(1);
  return { chip, editor, submissions, template };
}

test("Exiting Create mode sends the ordinary draft and template", async () => {
  const { chip, editor, submissions, template } =
    await setupCreateModeWithTemplate();
  click(chip);
  await screen.findByRole("group", { name: "Explore Okou capabilities" });
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

function inlineTemplateCover(index = 0): HTMLImageElement | null {
  const chip = composerInlineTemplates()[index];
  if (!chip) {
    throw new Error(`Expected an inline template at ${index}`);
  }
  return chip.querySelector("img");
}

async function setupCoveredPresentationTemplate() {
  setupModels();
  mockChatLifecycle(context);
  const editor = await setupComposer();
  const [first] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first) {
    throw new Error("Expected a presentation template");
  }
  await fill(editor, "Our launch");
  await enterCreateMode("Presentation");
  const shelf = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  click(button(first.title, shelf));
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
  return { first };
}

test("An inline template chip shows the chosen cover", async () => {
  const { first } = await setupCoveredPresentationTemplate();
  await waitFor(() => {
    expect(inlineTemplateCover()?.getAttribute("src")).toContain(first.slug);
  });
  expect(composerInlineTemplates()[0]).toHaveTextContent(first.title);
});

test("A template with no cover keeps the template glyph on its chip", async () => {
  setupModels();
  mockChatLifecycle(context);
  await setupComposer();
  const [template] = WEBSITE_TEMPLATE_ITEMS;
  if (!template) {
    throw new Error("Expected a website template");
  }
  await openTemplatePicker(userEvent.setup({ delay: null }), "Website");
  click(
    await screen.findByLabelText(`Select website template ${template.title}`),
  );
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
  expect(inlineTemplateCover()).toBeNull();
});
