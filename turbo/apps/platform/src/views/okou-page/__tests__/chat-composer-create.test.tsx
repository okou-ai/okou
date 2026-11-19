import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import {
  AGENT_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  THREAD_ID,
  composerInlineTemplates,
  createChatComposerHelpers,
  findComposerEditor,
  queryComposerModelTrigger,
} from "./chat-composer-test-helpers.ts";
import {
  readClipboardItemText,
  readSingleRichClipboardWrite,
} from "./chat-clipboard-test-helpers.ts";
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

function recordSubmissions(): UserMessageDocument[] {
  const submissions: UserMessageDocument[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      if (body.userMessage) {
        submissions.push(body.userMessage);
      }
    },
  });
  return submissions;
}

function textOf(message: UserMessageDocument | undefined): string {
  return (message?.parts ?? [])
    .flatMap((part) => {
      return part.type === "text" ? [part.text] : [];
    })
    .join("");
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
  expect(text).toBeVisible();
  expect(message).not.toHaveTextContent("Create");
  expect(message).not.toHaveTextContent("Additional generation settings");
  click(button("Copy message", message));
  const item = await readSingleRichClipboardWrite(clipboard);
  await expect(readClipboardItemText(item, "text/plain")).resolves.toBe(
    "Our launch brief",
  );
});

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
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  await screen.findByText("Review the launch brief");
  const editor = await findComposerEditor();
  const prompt = "Create a presentation. Keep these words in my message.";

  await enterCreateMode("Presentation", true);
  await fill(editor, prompt);
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
  const parts = queued[0]?.parts ?? [];
  expect(textOf(queued[0]).trim()).toBe(prompt);
  expect(parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create a presentation."),
  });
  expect(parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Slide count: 20-24"),
  });
});

test("Image adds a template without replacing the existing text", async () => {
  setupModels();
  mockChatLifecycle(context);
  const editor = await setupComposer();
  const [first] = ILLUSTRATION_TEMPLATE_ITEMS;
  if (!first) {
    throw new Error("Expected an image template");
  }
  await fill(editor, "Our launch");
  await enterCreateMode("Image");

  click(button("View all", screen.getByRole("tabpanel")));
  const catalog = await screen.findByRole("dialog");
  click(
    await within(catalog).findByLabelText(`Select template ${first.title}`),
  );

  await waitFor(() => {
    expect(catalog).not.toBeInTheDocument();
  });
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent(first.title);
  expect(composerInlineTemplates()[0]).toBeVisible();
  expect(editor).toHaveTextContent("Our launch");
  expect(taskChip("Image")).toBeInTheDocument();
  expect(queryComposerModelTrigger("Claude Fable 5.1")).toBeVisible();
});

test("Create image sends every edited draft template reference", async () => {
  setupModels();
  const submissions = recordSubmissions();
  const [first, second, replacement] = ILLUSTRATION_TEMPLATE_ITEMS.map(
    (template) => {
      return {
        title: template.title,
        request: {
          type: "illustration" as const,
          selection: { illustrationStyleId: template.illustrationStyleId },
        },
      };
    },
  );
  if (!first || !second || !replacement) {
    throw new Error("Expected three image templates");
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
  await setupComposer();
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(2);
  });
  await enterCreateMode("Image");
  const firstChip = composerInlineTemplates()[0];
  if (!firstChip) {
    throw new Error("Expected the first inline template");
  }

  click(button(`Preview template ${first.title}`, firstChip));
  const dialog = await screen.findByRole("dialog");
  click(
    await within(dialog).findByLabelText(
      `Select template ${replacement.title}`,
    ),
  );
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent(replacement.title);
  });
  click(button("Send"));

  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  const parts = submissions[0]?.parts ?? [];
  expect(parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create an image."),
  });
  expect(
    parts.filter((part) => {
      return part.type === "template";
    }),
  ).toStrictEqual([
    {
      type: "template",
      titleSnapshot: replacement.title,
      template: replacement.request,
    },
    { type: "template", titleSnapshot: second.title, template: second.request },
  ]);
  expect(textOf(submissions[0])).toContain("Our launch");
  expect(textOf(submissions[0])).toContain("for the cover.");
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

test("Exiting Create mode sends the ordinary draft and template", async () => {
  setupModels();
  const submissions = recordSubmissions();
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
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
  await enterCreateMode("Presentation");

  click(taskChip("Presentation"));
  await screen.findByRole("group", { name: "Explore Okou capabilities" });
  expect(editor).toHaveTextContent("Our launch /notes");
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  click(button("Send"));

  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  const parts = submissions[0]?.parts ?? [];
  expect(textOf(submissions[0])).toContain("Our launch /notes");
  expect(parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      titleSnapshot: template.title,
    }),
  );
  expect(parts).not.toContainEqual(
    expect.objectContaining({ type: "additional_info" }),
  );
});
