import { HttpResponse } from "msw";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  uploadsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
} from "@okouai/core";
import { expect, test } from "vitest";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import type {
  ComposerWorkflow,
  WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  AGENT_ID,
  composerInlineTemplates,
  context,
  expectInlineTemplateInComposer,
  findComposerEditor,
  mockActiveTemplateThread,
  mockAgent,
  mockThread,
  selectTemplate,
  THREAD_ID,
} from "./chat-composer-test-helpers.ts";

function installWorkflows(read: () => readonly ComposerWorkflow[]): void {
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [...read()]);
  });
}

function workflow(
  name: string,
  options: {
    readonly displayName?: string | null;
    readonly description?: string | null;
  } = {},
): ComposerWorkflow {
  return {
    id: crypto.randomUUID(),
    name,
    displayName: options.displayName ?? null,
    description: options.description ?? `${name} description`,
  };
}

function slashMenu(): HTMLElement {
  return screen.getByTestId("slash-workflow-menu");
}

function slashMenuButtons(): HTMLElement[] {
  return queryAllByRoleFast("button", slashMenu());
}

function slashWorkflowNames(): string[] {
  return Array.from(
    slashMenu().querySelectorAll('[data-slot="slash-workflow-name"]'),
    (element) => {
      return element.textContent ?? "";
    },
  );
}

function slashButton(name: string): HTMLElement {
  const button = slashMenuButtons().find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim().startsWith(name);
  });
  if (!button) {
    throw new Error(`Expected slash workflow button ${name}`);
  }
  return button;
}

function templateTab(name: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`Expected template tab ${name}`);
  }
  return tab;
}

async function openTemplateCategory(
  category: string,
  templateLabel = "Template",
): Promise<HTMLElement> {
  click(await screen.findByLabelText(templateLabel));
  const dialog = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!element) {
      throw new Error("Expected the template picker dialog");
    }
    expect(element).toBeVisible();
    return element;
  });
  const tab = templateTab(category);
  click(tab);
  await waitFor(() => {
    expect(tab).toHaveAttribute("aria-selected", "true");
  });
  return dialog;
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

function composerFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected composer file input");
  }
  return input;
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

function namedLink(name: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!link) {
    throw new Error(`Expected link ${name}`);
  }
  return link;
}

test("Multiple inline templates preserve every reference when you send", async () => {
  const first = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  const second = PRESENTATION_TEMPLATE_PICKER_ITEMS[1];
  if (!first || !second) {
    throw new Error("Expected at least two presentation templates");
  }
  let sentTemplateTitles: string[] = [];
  mockAgent();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "My thread",
    onSendRequest: (body) => {
      sentTemplateTitles =
        body.userMessage?.parts.flatMap((part) => {
          return part.type === "template" ? [part.titleSnapshot] : [];
        }) ?? [];
    },
  });
  installWorkflows(() => {
    return [];
  });
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
  await expect(screen.findByLabelText("Template")).resolves.toBeVisible();

  await waitFor(() => {
    return expect(composerInlineTemplates()).toHaveLength(2);
  });
  expect(editor.textContent).not.toContain("Ask me to automate");

  await user.click(editor);
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(sentTemplateTitles).toStrictEqual([first.title, second.title]);
    expect(structuredTemplateReferences()).toHaveLength(2);
  });
  expect(
    structuredTemplateReferences().map((reference) => {
      return reference.textContent;
    }),
  ).toStrictEqual([first.title, second.title]);
  expect(composerInlineTemplates()).toHaveLength(0);
});

test("Insert an attached workflow with slash suggestions", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [
      workflow("sales-research", { description: "Research qualified leads" }),
      workflow("support-escalation", {
        description: "Escalate support cases",
      }),
      workflow("research-digest", { description: "Digest research" }),
    ];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/");

  await waitFor(() => {
    expect(slashButton("/sales-research")).toBeVisible();
    expect(slashButton("/support-escalation")).toBeVisible();
  });

  await user.keyboard("ReSeArCh");
  const prefix = await waitFor(() => {
    return slashButton("/research-digest");
  });
  const substring = slashButton("/sales-research");
  expect(
    prefix.compareDocumentPosition(substring) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const emphasizedMatch = slashButton("/sales-research").querySelector(
    '[data-slot="workflow-query-match"]',
  );
  expect(emphasizedMatch).toHaveTextContent("research");

  await user.keyboard("{ArrowDown}{Enter}");

  await waitFor(() => {
    expect(editor).toHaveTextContent("/sales-research");
    expect(workflowHighlights(editor)).toHaveLength(1);
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
});

test("Find and insert a workflow with an abbreviated name", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [
      workflow("pr-design-acceptance-url"),
      workflow("pr-url-design-acceptance"),
      workflow("pr-auto"),
    ];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("Review /PdAu");

  await waitFor(() => {
    expect(slashWorkflowNames()).toStrictEqual(["/pr-design-acceptance-url"]);
  });
  const highlighted = Array.from(
    slashButton("/pr-design-acceptance-url").querySelectorAll(
      '[data-slot="workflow-query-match"]',
    ),
    (element) => {
      return element.textContent;
    },
  );
  expect(highlighted).toStrictEqual(["p", "d", "a", "u"]);

  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(editor).toHaveTextContent(/^Review \/pr-design-acceptance-url\s*$/);
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
});

test("Suggest effective workflows from an API that predates the composer endpoint", async () => {
  mockAgent();
  mockThread();
  const summary = (
    name: string,
    options: {
      readonly agentId?: string;
      readonly description: string;
      readonly visibility?: WorkflowSummary["visibility"];
      readonly shadowedBy?: WorkflowSummary["shadowedBy"];
    },
  ): WorkflowSummary => {
    return {
      id: crypto.randomUUID(),
      agentId: options.agentId ?? AGENT_ID,
      agentName: null,
      agentDisplayName: "Scout",
      name,
      displayName: null,
      description: options.description,
      visibility: options.visibility ?? "public",
      ownerUserId: "user-1",
      createdAt: "2026-06-01T00:00:00.000Z",
      canManage: true,
      canPublish: false,
      official: null,
      shadowedBy: options.shadowedBy ?? null,
    };
  };
  const privateWorkflow = summary("pr-auto", {
    description: "Review, repair, and merge one pull request",
    visibility: "private",
  });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(400, {
      error: { message: "Invalid uuid", code: "BAD_REQUEST" },
    });
  });
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return respond(200, [
      summary("pr-auto", {
        description: "Legacy goal-driven pull request automation",
        shadowedBy: {
          id: privateWorkflow.id,
          name: privateWorkflow.name,
          displayName: privateWorkflow.displayName,
        },
      }),
      privateWorkflow,
      summary("pr-review", {
        agentId: "e0000000-0000-4000-a000-000000000099",
        description: "Another agent's workflow",
      }),
    ]);
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/pr");

  await waitFor(() => {
    expect(slashButton("/pr-auto")).toHaveTextContent(
      "Review, repair, and merge one pull request",
    );
  });
  expect(slashWorkflowNames()).toStrictEqual(["/pr-auto"]);
});

test("Rank exact workflow names before prefixes, substrings, and abbreviations", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [
      workflow("pr-audit-report"),
      workflow("team-pr-auto"),
      workflow("pr-auto-deploy"),
      workflow("pr-auto"),
    ];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/pr-auto");

  await waitFor(() => {
    expect(slashWorkflowNames()).toStrictEqual([
      "/pr-auto",
      "/pr-auto-deploy",
      "/team-pr-auto",
      "/pr-audit-report",
    ]);
  });

  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(editor).toHaveTextContent(/^\/pr-auto\s*$/);
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
});

test("Send a template while the current run is active", async () => {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  mockAgent();
  mockActiveTemplateThread();
  installWorkflows(() => {
    return [];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  await findComposerEditor();
  await expect(
    screen.findByText("Start an active deck run"),
  ).resolves.toBeVisible();
  await selectTemplate(template);
  await waitFor(() => {
    expect(namedButton("Send")).toBeEnabled();
  });
  click(namedButton("Send"));

  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(0);
    expect(screen.getByTitle(`Presentation · ${template.title}`)).toBeVisible();
  });
  expect((await findComposerEditor()).textContent).toBe("");
});

test("Use the workflow template picker to send a workflow template", async () => {
  const template = WORKFLOW_TEMPLATE_ITEMS.find((item) => {
    return item.id === "workflow-template:github-pr-summarizer";
  });
  if (!template) {
    throw new Error("Expected the GitHub PR summarizer workflow template");
  }
  let sentTemplateTitle: string | undefined;
  mockAgent();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Workflow templates",
    onSendRequest: (body) => {
      sentTemplateTitle = body.userMessage?.parts.find((part) => {
        return part.type === "template";
      })?.titleSnapshot;
    },
  });
  installWorkflows(() => {
    return [];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup({ delay: null });
  const editor = await findComposerEditor();
  const dialog = await openTemplateCategory("Workflow");
  const search = within(dialog).getByLabelText("Search templates");
  expect(search).toBeVisible();
  await fill(search, template.title);
  click(
    await within(dialog).findByLabelText(
      `Select workflow template ${template.title}`,
    ),
  );

  await expectInlineTemplateInComposer(template.title);
  await user.click(editor);
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(sentTemplateTitle).toBe(template.title);
    expect(
      structuredTemplateReferences().some((reference) => {
        return reference.textContent === template.title;
      }),
    ).toBeTruthy();
  });
});

test("Workflow category filters narrow templates and preserve the search", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [];
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  await findComposerEditor();

  const dialog = await openTemplateCategory("Workflow");
  const everyone = namedButton("Everyone");
  const engineering = namedButton("Engineering");
  const inboxTemplateLabel = "Select workflow template Auto-inbox label";
  const engineeringTemplateLabel =
    "Select workflow template GitHub PR summarizer";
  await within(dialog).findByLabelText(inboxTemplateLabel);
  expect(
    within(dialog).getByLabelText(engineeringTemplateLabel),
  ).toBeInTheDocument();

  click(everyone);

  expect(everyone).toHaveAttribute("aria-pressed", "true");
  expect(within(dialog).getByLabelText(inboxTemplateLabel)).toBeInTheDocument();
  expect(
    within(dialog).queryByLabelText(engineeringTemplateLabel),
  ).not.toBeInTheDocument();

  const search = within(dialog).getByLabelText("Search templates");
  await fill(search, "merged pull requests");
  click(engineering);

  expect(search).toHaveValue("merged pull requests");
  await within(dialog).findByLabelText(engineeringTemplateLabel);
  expect(
    within(dialog).queryByLabelText(inboxTemplateLabel),
  ).not.toBeInTheDocument();
});

test("Continue from empty slash suggestions to all workflows", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/");
  await expect(
    screen.findByText("No matching workflows"),
  ).resolves.toBeVisible();

  await user.click(namedLink("View all workflows"));

  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
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
  installWorkflows(() => {
    return [];
  });
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
  const file = new File(["launch brief"], "brief.txt", {
    type: "text/plain",
  });
  fireEvent.change(composerFileInput(), { target: { files: [file] } });
  await expect(screen.findByText("brief.txt")).resolves.toBeVisible();
  await waitFor(() => {
    expect(namedButton("Cancel upload brief.txt")).toBeVisible();
    expect(namedButton("Send")).toBeDisabled();
  });

  click(namedButton("Send"));
  expect(sends).toBe(0);

  uploadGate.resolve();

  await waitFor(() => {
    expect(namedButton("Remove brief.txt")).toBeVisible();
    expect(namedButton("Send")).toBeEnabled();
    expect(screen.getByText("brief.txt")).toBeVisible();
    expect(composerInlineTemplates()).toHaveLength(1);
  });
});

test("Distinguish workflow tokens from text inside URLs", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [workflow("pr-review")];
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
    expect(workflowHighlights(editor)).toHaveLength(1);
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
});

test("Load workflows once the draft references a slash token", async () => {
  mockAgent();
  mockThread();
  const draftsAtRequest: (string | null)[] = [];
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    draftsAtRequest.push(
      document.querySelector(
        '[data-slot="chat-composer-card"] [contenteditable="true"]',
      )?.textContent ?? null,
    );
    return respond(200, [workflow("pr-review")]);
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("Review /pr-review");

  await waitFor(() => {
    expect(workflowHighlights(editor)).toHaveLength(1);
  });
  expect(draftsAtRequest).toHaveLength(1);
  expect(draftsAtRequest[0]).toContain("Review /");
});
