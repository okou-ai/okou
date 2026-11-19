import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import {
  type ComposerWorkflow,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
} from "@okouai/core";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
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
  THREAD_ID,
  composerInlineTemplates,
  createChatComposerHelpers,
  expectInlineTemplateInComposer,
  findComposerEditor,
  selectTemplate,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const { mockActiveTemplateThread, mockAgent, mockThread } =
  createChatComposerHelpers(context);

function installNoWorkflows(): void {
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, []);
  });
}

function workflow(name: string): ComposerWorkflow {
  return {
    id: crypto.randomUUID(),
    name,
    displayName: null,
    description: `${name} description`,
  };
}

function slashButton(name: string): HTMLElement {
  const menu = screen.getByTestId("slash-workflow-menu");
  const button = queryAllByRoleFast("button", menu).find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim().startsWith(name);
  });
  if (!button) {
    throw new Error(`Expected slash workflow button ${name}`);
  }
  return button;
}

function structuredTemplateReferences(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-structured-template-reference]",
    ),
  );
}

function workflowHighlights(editor: HTMLElement): HTMLElement[] {
  return Array.from(
    editor.querySelectorAll<HTMLElement>("span.text-brand-text"),
  );
}

function namedButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Expected button ${name}`);
  }
  return button;
}

test("Multiple inline templates preserve every reference when you send", async () => {
  const first = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  const second = PRESENTATION_TEMPLATE_PICKER_ITEMS[1];
  if (!first || !second) {
    throw new Error("Expected at least two presentation templates");
  }
  const sentTemplates: { title: string; template: unknown }[][] = [];
  mockAgent();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "My thread",
    onSendRequest: (body) => {
      sentTemplates.push(
        (body.userMessage?.parts ?? []).flatMap((part) => {
          return part.type === "template"
            ? [{ title: part.titleSnapshot, template: part.template }]
            : [];
        }),
      );
    },
  });
  installNoWorkflows();
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [first, second].map((template) => {
          return {
            type: "template" as const,
            titleSnapshot: template.title,
            template: {
              type: "presentation" as const,
              selection: { templateId: template.templateId },
            },
          };
        }),
      },
      draftAttachments: null,
    });
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(2);
  });

  await user.click(editor);
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(sentTemplates).toHaveLength(1);
  });
  expect(sentTemplates[0]).toMatchObject([
    {
      title: first.title,
      template: {
        type: "presentation",
        selection: { templateId: first.templateId },
      },
    },
    {
      title: second.title,
      template: {
        type: "presentation",
        selection: { templateId: second.templateId },
      },
    },
  ]);
  await waitFor(() => {
    expect(
      structuredTemplateReferences().map((reference) => {
        return reference.textContent;
      }),
    ).toStrictEqual([first.title, second.title]);
  });
  expect(composerInlineTemplates()).toHaveLength(0);
  expect(editor.textContent).toBe("");
});

test("Reopen workflow suggestions after clearing a pending draft", async () => {
  mockAgent();
  mockThread();
  const response = context.mocks.deferred<void>();
  let workflows = [workflow("pr-review")];
  context.mocks.api(
    workflowsCollectionContract.composer,
    async ({ respond }) => {
      const items = [...workflows];
      await response.promise;
      return respond(200, items);
    },
  );
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  const editor = await findComposerEditor();
  await fill(editor, "/pr");
  await screen.findByRole("status", { name: "Loading workflows..." });

  await fill(editor, "");
  await fill(editor, "/pr");
  response.resolve();
  await waitFor(() => {
    expect(slashButton("/pr-review")).toBeVisible();
  });

  workflows = [];
  await fill(editor, "");
  await fill(editor, "/pr");
  const review = await waitFor(() => {
    return slashButton("/pr-review");
  });
  expect(review).toBeVisible();
  click(review);

  await waitFor(() => {
    expect(workflowHighlights(editor)).toHaveLength(1);
  });
  expect(workflowHighlights(editor)[0]).toHaveTextContent("/pr-review");
});

test("Send a template while the current run is active", async () => {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  mockAgent();
  mockActiveTemplateThread();
  installNoWorkflows();
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  const editor = await findComposerEditor();
  await expect(
    screen.findByText("Start an active deck run"),
  ).resolves.toBeVisible();
  await selectTemplate(template);
  await waitFor(() => {
    expect(namedButton("Send")).toBeEnabled();
  });

  click(namedButton("Send"));

  await waitFor(() => {
    expect(
      screen.getByText(template.title, {
        selector: "[data-structured-template-reference] span",
      }),
    ).toBeVisible();
  });
  expect(composerInlineTemplates()).toHaveLength(0);
  expect(editor.textContent).toBe("");
});

test("Use the workflow template picker to send a workflow template", async () => {
  const template = WORKFLOW_TEMPLATE_ITEMS.find((item) => {
    return item.id === "workflow-template:github-pr-summarizer";
  });
  if (!template) {
    throw new Error("Expected the GitHub PR summarizer workflow template");
  }
  const sentTitles: (string | undefined)[] = [];
  mockAgent();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Workflow templates",
    onSendRequest: (body) => {
      sentTitles.push(
        body.userMessage?.parts.find((part) => {
          return part.type === "template";
        })?.titleSnapshot,
      );
    },
  });
  installNoWorkflows();
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  const user = userEvent.setup({ delay: null });
  const editor = await findComposerEditor();
  await clickComposerAddMenuItem("Template");
  const dialog = await screen.findByRole("dialog");
  const tab = queryAllByRoleFast("tab", dialog).find((candidate) => {
    return candidate.textContent?.trim() === "Workflow";
  });
  if (!tab) {
    throw new Error("Expected the Workflow template tab");
  }
  click(tab);
  await waitFor(() => {
    expect(tab).toHaveAttribute("aria-selected", "true");
  });

  await fill(within(dialog).getByLabelText("Search templates"), template.title);
  click(
    await within(dialog).findByLabelText(
      `Select workflow template ${template.title}`,
    ),
  );
  await expectInlineTemplateInComposer(template.title);
  const insertedTemplate = composerInlineTemplates().find((chip) => {
    return chip.textContent?.includes(template.title);
  });
  expect(insertedTemplate).toBeVisible();
  await user.click(editor);
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(sentTitles).toStrictEqual([template.title]);
  });
  await waitFor(() => {
    expect(
      structuredTemplateReferences().map((reference) => {
        return reference.textContent;
      }),
    ).toContain(template.title);
  });
});

test("Wait for a template attachment before sending", async () => {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  const uploadId = "a1000000-0000-4000-a000-000000000901";
  const uploadUrl = `https://mock-upload.r2.test/${uploadId}`;
  const publicUrl = `https://cdn.vm7.io/chat/${uploadId}/brief.txt`;
  const uploadGate = context.mocks.deferred<void>();
  let sends = 0;
  mockAgent();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Template upload",
    onSendRequest: () => {
      sends += 1;
    },
  });
  installNoWorkflows();
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    return respond(200, {
      id: uploadId,
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url: publicUrl,
      uploadUrl,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(uploadUrl, async ({ withSignal }) => {
    await withSignal(uploadGate.promise);
    return new HttpResponse(null, { status: 200 });
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  await findComposerEditor();
  await selectTemplate(template);
  const input = document.querySelector<HTMLInputElement>(
    '[data-slot="chat-composer-card"] input[type="file"]',
  );
  if (!input) {
    throw new Error("Expected composer file input");
  }
  fireEvent.change(input, {
    target: {
      files: [new File(["launch brief"], "brief.txt", { type: "text/plain" })],
    },
  });
  await waitFor(() => {
    expect(namedButton("Cancel upload brief.txt")).toBeVisible();
  });

  expect(namedButton("Send")).toBeDisabled();
  click(namedButton("Send"));
  uploadGate.resolve();

  await waitFor(() => {
    expect(namedButton("Remove brief.txt")).toBeVisible();
  });
  expect(namedButton("Send")).toBeEnabled();
  expect(screen.getByText("brief.txt")).toBeVisible();
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  expect(sends).toBe(0);
});

test("Distinguish workflow tokens from text inside URLs", async () => {
  mockAgent();
  mockThread();
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [workflow("pr-review")]);
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  const user = userEvent.setup();
  const editor = await findComposerEditor();
  const url = "https://www.okou.ai/en/use-cases/pr-review";
  await user.click(editor);
  await user.keyboard("/pr-review ");
  await waitFor(() => {
    expect(workflowHighlights(editor)).toHaveLength(1);
  });

  await user.keyboard(url);

  await waitFor(() => {
    expect(editor).toHaveTextContent(url);
  });
  expect(editor).toBeVisible();
  expect(workflowHighlights(editor)).toHaveLength(1);
  expect(workflowHighlights(editor)[0]).toHaveTextContent(/^\/pr-review$/u);
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});
