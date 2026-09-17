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
  mockComposerThreadSnapshot,
  mockThread,
  selectTemplate,
  THREAD_ID,
  workflowSummary,
} from "./chat-composer-test-helpers.ts";

const SPLIT_THREAD_ID = "b1000000-0000-4000-a000-000000000105";

type WorkflowFixture = ReturnType<typeof workflowSummary>;

function installWorkflows(read: () => readonly WorkflowFixture[]): {
  readonly requests: { readonly agentId: string | undefined }[];
} {
  const requests: { readonly agentId: string | undefined }[] = [];
  context.mocks.api(workflowsCollectionContract.list, ({ query, respond }) => {
    requests.push({ agentId: query.agentId });
    return respond(200, [...read()]);
  });
  return { requests };
}

function workflow(
  name: string,
  options: {
    readonly agentId?: string;
    readonly displayName?: string | null;
    readonly description?: string | null;
    readonly visibility?: WorkflowFixture["visibility"];
    readonly shadowedBy?: WorkflowFixture["shadowedBy"];
  } = {},
): WorkflowFixture {
  return {
    ...workflowSummary({
      name,
      agentId: options.agentId ?? AGENT_ID,
      displayName: options.displayName ?? null,
      description: options.description ?? `${name} description`,
    }),
    visibility: options.visibility ?? "public",
    shadowedBy: options.shadowedBy ?? null,
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

function composerForThread(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  const composer = container?.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Message"]',
  );
  if (!composer) {
    throw new Error(`Expected composer for ${threadId}`);
  }
  return composer;
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

function installOffsetVisualViewport(): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = Object.assign(new EventTarget(), {
    width: 1024,
    height: 620,
    offsetLeft: 24,
    offsetTop: 160,
    pageLeft: 24,
    pageTop: 160,
    scale: 1,
    onresize: null,
    onscroll: null,
    onscrollend: null,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(window, "visualViewport", descriptor);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    },
    { once: true },
  );
}

test.each(["insert", "send"])(
  "Multiple inline templates preserve every reference when you %s",
  async (action) => {
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
    if (action === "send") {
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
    }

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    const user = userEvent.setup();
    const editor = await findComposerEditor();
    await expect(screen.findByLabelText("Template")).resolves.toBeVisible();

    if (action === "insert") {
      await selectTemplate(first);
      await selectTemplate(second);
    }
    await waitFor(() => {
      return expect(composerInlineTemplates()).toHaveLength(2);
    });
    expect(editor.textContent).not.toContain("Ask me to automate");
    if (action === "insert") {
      return;
    }

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
  },
);

test("Replace an inline template after sending a message", async () => {
  const first = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  const replacement = PRESENTATION_TEMPLATE_PICKER_ITEMS[2];
  if (!first || !replacement) {
    throw new Error("Expected presentation templates to insert and replace");
  }
  mockAgent();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "My thread",
  });
  installWorkflows(() => {
    return [];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup({ delay: null });
  await selectTemplate(first);
  await user.click(await findComposerEditor());
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(structuredTemplateReferences()).toHaveLength(1);
    expect(structuredTemplateReferences()[0]).toHaveTextContent(first.title);
    expect(composerInlineTemplates()).toHaveLength(0);
  });

  await selectTemplate(first);
  const inlineTemplate = composerInlineTemplates()[0];
  if (!inlineTemplate) {
    throw new Error("Expected an inline template to replace");
  }
  const inlineButton = queryAllByRoleFast("button", inlineTemplate)[0];
  if (!inlineButton) {
    throw new Error("Expected inline template button");
  }
  click(inlineButton);
  await expect(screen.findByRole("dialog")).resolves.toBeVisible();
  click(screen.getByLabelText(`Select template ${replacement.title}`));

  await waitFor(() => {
    const templates = composerInlineTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0]).toHaveTextContent(replacement.title);
  });
  expect(structuredTemplateReferences()).toHaveLength(1);
  expect(structuredTemplateReferences()[0]).toHaveTextContent(first.title);
});

test("Dismiss workflow suggestions without losing the query", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [workflow("sales-research")];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/sales");
  await expect(
    screen.findByTestId("slash-workflow-menu"),
  ).resolves.toBeVisible();

  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
    expect(editor).toHaveFocus();
    expect(editor).toHaveTextContent("/sales");
  });

  await user.keyboard("{ArrowLeft}{ArrowRight}");
  await expect(
    screen.findByTestId("slash-workflow-menu"),
  ).resolves.toBeVisible();
  const templateButton = screen.getByLabelText("Template");
  templateButton.focus();

  await waitFor(() => {
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
    expect(templateButton).toHaveFocus();
    expect(editor).toHaveTextContent("/sales");
  });
});

async function openWorkflowRefreshChat(initialWorkflows: WorkflowFixture[]) {
  let workflows = initialWorkflows;
  const primaryThread = {
    id: THREAD_ID,
    agentId: AGENT_ID,
    title: "Primary workflow chat",
  };
  const splitThread = {
    id: SPLIT_THREAD_ID,
    agentId: AGENT_ID,
    title: "Split workflow chat",
  };
  mockAgent();
  mockThread();
  mockComposerThreadSnapshot([primaryThread, splitThread]);
  const traffic = installWorkflows(() => {
    return workflows;
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}?sidebar=${SPLIT_THREAD_ID}`,
  });

  const user = userEvent.setup({ delay: null });
  await waitFor(() => {
    expect(composerForThread(THREAD_ID)).toBeVisible();
    expect(composerForThread(SPLIT_THREAD_ID)).toBeVisible();
  });
  const primaryEditor = composerForThread(THREAD_ID);
  const splitEditor = composerForThread(SPLIT_THREAD_ID);
  await user.click(primaryEditor);
  await user.keyboard("/release-report");
  await waitFor(() => {
    expect(primaryEditor).toHaveTextContent("/release-report");
  });
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription(
        `chatThreadWorkflowsChanged:${THREAD_ID}`,
      ),
    ).toBeTruthy();
    expect(
      context.mocks.ably.hasSubscription(
        `chatThreadWorkflowsChanged:${SPLIT_THREAD_ID}`,
      ),
    ).toBeTruthy();
  });
  return {
    primaryEditor,
    splitEditor,
    user,
    traffic,
    updateWorkflows(next: WorkflowFixture[]) {
      workflows = next;
      context.mocks.ably.trigger(`chatThreadWorkflowsChanged:${THREAD_ID}`);
      context.mocks.ably.trigger(
        `chatThreadWorkflowsChanged:${SPLIT_THREAD_ID}`,
      );
    },
  };
}

test("A newly available workflow highlights the existing draft without changing its text", async () => {
  const { primaryEditor, updateWorkflows } = await openWorkflowRefreshChat([]);
  expect(workflowHighlights(primaryEditor)).toHaveLength(0);
  updateWorkflows([workflow("release-report")]);

  await waitFor(() => {
    expect(primaryEditor).toHaveTextContent("/release-report");
    expect(workflowHighlights(primaryEditor)).toHaveLength(1);
    expect(slashButton("/release-report")).toBeVisible();
  });
});

const workflowRefreshPanes = [
  { pane: "primary", threadId: THREAD_ID, input: " /latest", highlights: 2 },
  { pane: "split", threadId: SPLIT_THREAD_ID, input: "/latest", highlights: 1 },
] as const;

async function discoverLatestWorkflow({
  threadId,
  input,
}: {
  threadId: string;
  input: string;
}) {
  const { primaryEditor, user, traffic, updateWorkflows } =
    await openWorkflowRefreshChat([workflow("release-report")]);
  await waitFor(() => {
    return expect(workflowHighlights(primaryEditor)).toHaveLength(1);
  });
  updateWorkflows([workflow("release-report"), workflow("first-live-change")]);
  await waitFor(() => {
    expect(traffic.requests.length).toBeGreaterThanOrEqual(4);
  });
  updateWorkflows([
    workflow("release-report"),
    workflow("first-live-change"),
    workflow("latest-attached"),
  ]);

  const editor = composerForThread(threadId);
  await user.click(editor);
  await user.keyboard(input);
  await waitFor(() => {
    expect(slashButton("/latest-attached")).toBeVisible();
  });
  return { primaryEditor, user, editor };
}

test.each(workflowRefreshPanes)(
  "Successive workflow updates appear in the $pane composer while both panes are open",
  async (pane) => {
    await discoverLatestWorkflow(pane);
    expect(slashButton("/latest-attached")).toBeVisible();
  },
);

test.each(workflowRefreshPanes)(
  "Insert the latest live workflow into the $pane composer without replacing its draft",
  async (pane) => {
    const { primaryEditor, user, editor } = await discoverLatestWorkflow(pane);
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(workflowHighlights(editor)).toHaveLength(pane.highlights);
      expect(editor).toHaveTextContent("/latest-attached");
      expect(primaryEditor).toHaveTextContent("/release-report");
    });
  },
);

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
      workflow("organization-only", {
        agentId: "e0000000-0000-4000-a000-000000000099",
      }),
    ];
  });
  installOffsetVisualViewport();

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/");

  await waitFor(() => {
    expect(slashButton("/sales-research")).toBeVisible();
    expect(slashButton("/support-escalation")).toBeVisible();
    expect(screen.queryByText("/organization-only")).toBeNull();
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
  expect(window.visualViewport?.offsetTop).toBe(160);
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

test("Rank compact workflow abbreviations before scattered matches", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [
      workflow("pr-32809-app-production-watch"),
      workflow("team-pr-auto"),
      workflow("pr-auto-bravo"),
      workflow("pr-auto-alpha"),
      workflow("pr-auto"),
    ];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/prauto");

  await waitFor(() => {
    expect(slashWorkflowNames()).toStrictEqual([
      "/pr-auto",
      "/pr-auto-bravo",
      "/pr-auto-alpha",
      "/team-pr-auto",
      "/pr-32809-app-production-watch",
    ]);
  });
  const highlighted = Array.from(
    slashButton("/pr-auto").querySelectorAll(
      '[data-slot="workflow-query-match"]',
    ),
    (element) => {
      return element.textContent;
    },
  );
  expect(highlighted).toStrictEqual(["pr", "auto"]);

  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(editor).toHaveTextContent(/^\/pr-auto\s*$/);
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
});

test("Keep numeric workflow identifiers contiguous in abbreviated queries", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [
      workflow("pr-26-809-ship-watch"),
      workflow("pr-26819-ship-watch"),
      workflow("pr-26809-ship-watch"),
    ];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const editor = await findComposerEditor();
  await fill(editor, "/26809");
  await waitFor(() => {
    expect(slashWorkflowNames()).toStrictEqual(["/pr-26809-ship-watch"]);
  });

  await fill(editor, "/pr26809");
  await waitFor(() => {
    expect(slashWorkflowNames()).toStrictEqual(["/pr-26809-ship-watch"]);
  });
});

test("Keep strict workflow matching for queries shorter than three characters", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [workflow("pr-design-acceptance-url")];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const editor = await findComposerEditor();
  await fill(editor, "/pd");
  await expect(
    screen.findByText("No matching workflows"),
  ).resolves.toBeVisible();
});

test("Suggest only the effective workflow when a private workflow shadows a public workflow", async () => {
  const privateWorkflow = workflow("pr-auto", {
    displayName: "PR Auto",
    description: "Review, repair, and merge one pull request",
    visibility: "private",
  });
  const publicWorkflow = workflow("pr-auto", {
    displayName: "PR Auto",
    description: "Legacy goal-driven pull request automation",
    shadowedBy: {
      id: privateWorkflow.id,
      name: privateWorkflow.name,
      displayName: privateWorkflow.displayName,
    },
  });
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [
      workflow("aardvark"),
      publicWorkflow,
      privateWorkflow,
      workflow("pr-implement"),
      workflow("topic"),
    ];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/pr");

  await waitFor(() => {
    const matchingButtons = slashMenuButtons().filter((button) => {
      return button.textContent
        ?.replace(/\s+/gu, " ")
        .trim()
        .startsWith("/pr-auto");
    });
    expect(matchingButtons).toHaveLength(1);
  });
  expect(slashButton("/pr-auto")).toHaveTextContent(
    "Review, repair, and merge one pull request",
  );
  expect(
    screen.queryByText("Legacy goal-driven pull request automation"),
  ).toBeNull();
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

test.each(["find", "send"])(
  "Use the workflow template picker to %s a workflow template",
  async (action) => {
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
    await fill(
      search,
      action === "find" ? "merged pull requests" : template.title,
    );
    click(
      await within(dialog).findByLabelText(
        `Select workflow template ${template.title}`,
      ),
    );

    await expectInlineTemplateInComposer(template.title);
    if (action === "find") {
      return;
    }
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
  },
);

test("Continue from empty slash suggestions to all workflows", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [
      workflow("organization-catalog-workflow", {
        agentId: "e0000000-0000-4000-a000-000000000099",
      }),
    ];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/");
  await expect(
    screen.findByText("No matching workflows"),
  ).resolves.toBeVisible();

  click(namedLink("View all workflows"));

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
  await user.keyboard(url);

  await waitFor(() => {
    expect(editor).toHaveTextContent(url);
    expect(workflowHighlights(editor)).toHaveLength(0);
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
});
