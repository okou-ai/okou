import { workflowsCollectionContract } from "@okouai/api-contracts";
import {
  userTemplatesContract,
  type UserTemplateCatalogEntry,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  CREATE_AUTOMATION_CHAT_PROMPT,
  scheduledAutomationChatPrompt,
} from "../../../signals/chat-page/workflow-prompt-action.ts";
import {
  AGENT_ID,
  buildRunModel,
  composerWorkflow,
  context,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockPersonalModelRoutes,
  tabByText,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000930";
const WORKFLOWS = ["axiom-red", "axiom-status", "axiom-traces"] as const;

async function openSlashActions({
  path = `/agents/${AGENT_ID}/chat`,
  enabled = true,
  noModelChoice = false,
  noEffort = false,
  featureSwitches = {},
}: {
  readonly path?: string;
  readonly enabled?: boolean;
  readonly noModelChoice?: boolean;
  /** The chat model runs without a runtime route, so it has no levels. */
  readonly noEffort?: boolean;
  readonly featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
} = {}) {
  mockAgent();
  mockPersonalModelRoutes();
  mockBillingCapabilities({ restrictedBuiltInModels: false });
  context.mocks.data.userModelPreference({
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: "2026-09-07T00:00:00.000Z",
  });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(
      200,
      WORKFLOWS.map((name) => {
        return composerWorkflow(name, `Description of ${name}`);
      }),
    );
  });
  mockChatLifecycle(context, { threadId: THREAD_ID });
  if (noModelChoice) {
    context.mocks.data.availableRunModels([]);
  }
  if (noEffort) {
    const runModel = buildRunModel({
      model: "claude-fable-5-1",
      modelLabel: "Claude Fable 5.1",
      providerType: "claude-code-oauth-token",
    });
    context.mocks.data.availableRunModels([
      {
        ...runModel,
        memberEffective: {
          ...runModel.memberEffective,
          runtimeProviderType: null,
        },
      },
    ]);
  }
  await setupPage({
    context,
    path,
    featureSwitches: {
      ...featureSwitches,
      [FeatureSwitchKey.SlashActions]: enabled,
    },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  return { editor, menu };
}

function menuButton(name: string): HTMLElement {
  const button = queryAllByRoleFast(
    "button",
    screen.getByTestId("slash-workflow-menu"),
  ).find((candidate) => {
    const label =
      candidate.querySelector('[data-slot="slash-workflow-name"]') ?? candidate;
    return label.textContent?.replace(/\s+/gu, " ").trim().startsWith(name);
  });
  if (!button) {
    throw new Error(`Expected slash menu button ${name}`);
  }
  return button;
}

function firstLevelNames(): string[] {
  return queryAllByRoleFast("button", screen.getByTestId("slash-workflow-menu"))
    .filter((button) => {
      return !button.closest(
        '[data-slot="slash-workflow-detail"], [data-slot="slash-templates-detail"], [data-slot="slash-submenu-detail"]',
      );
    })
    .map((button) => {
      return button.textContent?.replace(/\s+/gu, " ").trim() ?? "";
    });
}

test("The bare slash leads with chat actions, then Workflows and Templates with their counts", async () => {
  await openSlashActions();
  await waitFor(() => {
    expect(firstLevelNames()).toHaveLength(6);
  });
  const names = firstLevelNames();
  expect(
    names.slice(0, 4).map((name) => {
      return name.split(" ")[0];
    }),
  ).toStrictEqual(["Model", "Effort", "Connect", "Schedule"]);
  expect(names[4]).toBe("Workflows 3");
  expect(names[5]).toMatch(/^Templates \d+$/u);
});

test("A chat adds the actions on the chat itself", async () => {
  await openSlashActions({ path: `/chats/${THREAD_ID}` });
  await waitFor(() => {
    expect(menuButton("Rename chat")).toBeInTheDocument();
  });
  expect(menuButton("New chat")).toBeInTheDocument();
  expect(menuButton("Pin chat")).toBeInTheDocument();
  expect(menuButton("Share chat")).toBeInTheDocument();
});

test("Pointing at Workflows opens its list beside the first level", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  const user = userEvent.setup();
  const { editor, menu } = await openSlashActions();
  const entry = await waitFor(() => {
    return menuButton("Workflows");
  });
  fireEvent.mouseOver(entry);
  fireEvent.mouseMove(entry);

  const pane = within(menu).getByRole("region", { name: "Workflows" });
  expect(entry).toHaveAttribute("aria-expanded", "true");
  expect(within(pane).getByText("New workflow")).toBeInTheDocument();
  expect(within(pane).getByText("Manage workflows")).toBeInTheDocument();

  await user.click(menuButton("/axiom-status"));

  await waitFor(() => {
    expect(editor).toHaveTextContent("Draft /axiom-status");
  });
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("The keyboard enters the Workflows list and leaves it again", async () => {
  context.mocks.browser.matchMedia(true);
  const user = userEvent.setup();
  const { editor } = await openSlashActions();
  await waitFor(() => {
    return menuButton("Workflows");
  });

  // Up from the composer reaches Templates, then Workflows.
  await user.keyboard("{ArrowUp}{ArrowUp}");
  expect(menuButton("Workflows")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowRight}");
  expect(menuButton("/axiom-red")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowLeft}");
  expect(menuButton("Workflows")).toHaveAttribute("data-active", "true");
  expect(editor).toHaveTextContent(/^Draft \/$/u);

  await user.keyboard("{Enter}{ArrowDown}{Enter}");
  await waitFor(() => {
    expect(editor).toHaveTextContent("Draft /axiom-status");
  });
});

test("Templates opens its types with their counts, and Browse all opens the picker", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  const user = userEvent.setup();
  const { menu } = await openSlashActions();
  const entry = await waitFor(() => {
    return menuButton("Templates");
  });
  fireEvent.mouseOver(entry);
  fireEvent.mouseMove(entry);

  const pane = within(menu).getByRole("region", { name: "Templates" });
  expect(within(pane).getByText("Presentation")).toBeInTheDocument();
  await user.click(within(pane).getByText("Browse all templates"));

  await screen.findByRole("dialog");
  expect(tabByText("Presentation")).toBeInTheDocument();
});

function pointAt(row: HTMLElement): void {
  fireEvent.mouseOver(row);
  fireEvent.mouseMove(row);
}

function paneRow(pane: HTMLElement, name: string): HTMLElement {
  const row = queryAllByRoleFast("button", pane).find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === name;
  });
  if (!row) {
    throw new Error(`Expected ${name} in the second level`);
  }
  return row;
}

function modelTrigger(name: RegExp): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((button) => {
    return name.test(button.getAttribute("aria-label") ?? "");
  });
}

test("Pointing at Model lists the models beside the first level, and one switches the chat", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  const user = userEvent.setup();
  const { editor, menu } = await openSlashActions();
  const entry = await waitFor(() => {
    return menuButton("Model");
  });
  pointAt(entry);

  const pane = within(menu).getByRole("region", { name: "Model" });
  expect(entry).toHaveAttribute("aria-expanded", "true");
  // A row names its model once the catalog it reads has resolved.
  await waitFor(() => {
    expect(paneRow(pane, "Claude Fable 5.1")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
  await user.click(paneRow(pane, "Claude Sonnet 5"));

  await waitFor(() => {
    expect(modelTrigger(/^Claude Sonnet 5\b/u)).toBeInTheDocument();
  });
  expect(editor).toHaveTextContent(/^Draft$/u);
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("Pointing at Effort lists its levels, and one sets the chat's effort", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  const user = userEvent.setup();
  const { menu } = await openSlashActions();
  const entry = await waitFor(() => {
    return menuButton("Effort");
  });
  pointAt(entry);

  const pane = within(menu).getByRole("region", { name: "Effort" });
  await user.click(paneRow(pane, "Low"));

  await waitFor(() => {
    expect(modelTrigger(/^Claude Fable 5\.1, Low$/u)).toBeInTheDocument();
  });
});

test("Schedule lists how often to run, and a choice writes the request with it", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  const user = userEvent.setup();
  const { editor, menu } = await openSlashActions();
  await waitFor(() => {
    return menuButton("Schedule");
  });

  // Choosing the row opens its choices instead of leaving the menu.
  await user.click(menuButton("Schedule"));
  const pane = within(menu).getByRole("region", { name: "Schedule" });
  await user.click(paneRow(pane, "Every weekday"));

  await waitFor(() => {
    expect(editor).toHaveTextContent(
      `Draft ${scheduledAutomationChatPrompt("every weekday at 9:00")}`,
    );
  });
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("Custom schedule writes the request without a cadence", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  const user = userEvent.setup();
  const { editor, menu } = await openSlashActions();
  pointAt(
    await waitFor(() => {
      return menuButton("Schedule");
    }),
  );

  const pane = within(menu).getByRole("region", { name: "Schedule" });
  await user.click(paneRow(pane, "Custom schedule"));

  await waitFor(() => {
    expect(editor).toHaveTextContent(`Draft ${CREATE_AUTOMATION_CHAT_PROMPT}`);
  });
});

test("The keyboard enters an action's choices and leaves them again", async () => {
  context.mocks.browser.matchMedia(true);
  const user = userEvent.setup();
  const { editor } = await openSlashActions();
  await waitFor(() => {
    return menuButton("Schedule");
  });

  // Up from the composer reaches Templates, Workflows, then Schedule.
  await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
  expect(menuButton("Schedule")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowRight}");
  expect(menuButton("Every morning")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowLeft}");
  expect(menuButton("Schedule")).toHaveAttribute("data-active", "true");

  await user.keyboard("{Enter}{ArrowDown}{Enter}");
  await waitFor(() => {
    expect(editor).toHaveTextContent(
      `Draft ${scheduledAutomationChatPrompt("every weekday at 9:00")}`,
    );
  });
});

test("On a narrow screen an action's choices replace the first level", async () => {
  context.mocks.browser.matchMedia(false);
  const user = userEvent.setup();
  await openSlashActions();
  await waitFor(() => {
    return menuButton("Effort");
  });

  await user.click(menuButton("Effort"));
  expect(menuButton("Low")).toBeInTheDocument();
  expect(
    firstLevelNames().find((name) => {
      return name.startsWith("Model");
    }),
  ).toBeUndefined();

  await user.click(menuButton("Effort"));
  await waitFor(() => {
    expect(menuButton("Model")).toBeInTheDocument();
  });
});

test("Typing after the slash still searches workflows and types in one list", async () => {
  await openSlashActions();
  await fill(await findComposerEditor(), "Draft /axi");
  await waitFor(() => {
    expect(menuButton("/axiom-red")).toBeInTheDocument();
  });
  expect(
    firstLevelNames().find((name) => {
      return name.startsWith("Model");
    }),
  ).toBeUndefined();
});

test("With the switch off the overview keeps its workflow rows", async () => {
  await openSlashActions({ enabled: false });
  await waitFor(() => {
    expect(menuButton("/axiom-red")).toBeInTheDocument();
  });
  expect(
    firstLevelNames().find((name) => {
      return name.startsWith("Model");
    }),
  ).toBeUndefined();
});

test("Model and Effort stay out when the composer offers no model choice", async () => {
  await openSlashActions({ noModelChoice: true });
  await waitFor(() => {
    expect(menuButton("Schedule")).toBeInTheDocument();
  });
  // The toolbar shows no model picker then, so there is nothing to open.
  expect(
    firstLevelNames().find((name) => {
      return name.startsWith("Model") || name.startsWith("Effort");
    }),
  ).toBeUndefined();
});

test("Typing after the slash finds a chat action, and Enter runs it", async () => {
  const user = userEvent.setup();
  const { editor } = await openSlashActions();
  await fill(editor, "Draft /sch");
  await waitFor(() => {
    expect(menuButton("Schedule")).toHaveAttribute("data-active", "true");
  });
  expect(
    within(screen.getByTestId("slash-workflow-menu")).getByText("Actions"),
  ).toBeInTheDocument();
  // Actions match from the start of a word, so `sch` names nothing else.
  expect(
    firstLevelNames().find((name) => {
      return name.startsWith("Model");
    }),
  ).toBeUndefined();

  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(editor).toHaveTextContent(`Draft ${CREATE_AUTOMATION_CHAT_PROMPT}`);
  });
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("A typed command keyword finds the chat's own actions", async () => {
  await openSlashActions({ path: `/chats/${THREAD_ID}` });
  await fill(await findComposerEditor(), "Draft /title");
  await waitFor(() => {
    expect(menuButton("Rename chat")).toBeInTheDocument();
  });
  expect(
    firstLevelNames().find((name) => {
      return name.startsWith("Share");
    }),
  ).toBeUndefined();
});

function customTemplate(
  kind: UserTemplateKind,
  index: number,
): UserTemplateCatalogEntry {
  const id = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
  return {
    id,
    kind,
    title: `My ${kind} template ${String(index)}`,
    sourceFilename: `source-${kind}.pdf`,
    coverUrl: null,
    coverHasMorePages: false,
    pageCount: null,
    visibility: "private",
    ownerUserId: "user_self",
    ownerDisplayName: "Dana Self",
    canManage: true,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    previewAssets: [],
  };
}

test("Template counts include the custom templates listed beside the built-in ones", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, [
      customTemplate("presentation", 1),
      customTemplate("presentation", 2),
      customTemplate("document", 3),
    ]);
  });
  const { menu } = await openSlashActions({
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: true,
      [FeatureSwitchKey.BuiltinDocumentTemplates]: false,
    },
  });
  // Built-in documents are off, so Document counts only the custom one.
  const counts = {
    Presentation: PRESENTATION_TEMPLATE_PICKER_ITEMS.length + 2,
    Document: 1,
    Illustration: ILLUSTRATION_TEMPLATE_ITEMS.length,
    Website: WEBSITE_TEMPLATE_ITEMS.length,
  };
  const total = Object.values(counts).reduce((sum, count) => {
    return sum + count;
  }, 0);
  const entry = await waitFor(() => {
    return menuButton(`Templates ${String(total)}`);
  });
  fireEvent.mouseOver(entry);
  fireEvent.mouseMove(entry);

  const pane = within(menu).getByRole("region", { name: "Templates" });
  const tabs = queryAllByRoleFast("button", pane).map((tab) => {
    return tab.textContent?.replace(/\s+/gu, " ").trim();
  });
  expect(tabs).toStrictEqual(
    expect.arrayContaining(
      Object.entries(counts).map(([label, count]) => {
        return `${label} ${String(count)}`;
      }),
    ),
  );
});

test("Effort stays out when the chat model has no effort levels", async () => {
  await openSlashActions({ noEffort: true });
  await waitFor(() => {
    expect(menuButton("Model")).toBeInTheDocument();
  });
  expect(
    firstLevelNames().find((name) => {
      return name.startsWith("Effort");
    }),
  ).toBeUndefined();
});

test("A template type with nothing to show gets no tab", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, [customTemplate("presentation", 1)]);
  });
  const { menu } = await openSlashActions({
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: true,
      [FeatureSwitchKey.BuiltinDocumentTemplates]: false,
    },
  });
  const presentations = PRESENTATION_TEMPLATE_PICKER_ITEMS.length + 1;
  const entry = await waitFor(() => {
    return menuButton(
      `Templates ${String(presentations + ILLUSTRATION_TEMPLATE_ITEMS.length + WEBSITE_TEMPLATE_ITEMS.length)}`,
    );
  });
  fireEvent.mouseOver(entry);
  fireEvent.mouseMove(entry);

  const pane = within(menu).getByRole("region", { name: "Templates" });
  const tabs = queryAllByRoleFast("button", pane).map((tab) => {
    return tab.textContent?.replace(/\s+/gu, " ").trim() ?? "";
  });
  expect(tabs).toContain(`Presentation ${String(presentations)}`);
  // Built-in documents are off and no custom document exists.
  expect(
    tabs.find((tab) => {
      return tab.startsWith("Document");
    }),
  ).toBeUndefined();
});

test("A slash typed in the composer's right half puts the menu at the right edge", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  mockAgent();
  mockPersonalModelRoutes();
  mockBillingCapabilities({ restrictedBuiltInModels: false });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(
      200,
      WORKFLOWS.map((name) => {
        return composerWorkflow(name, `Description of ${name}`);
      }),
    );
  });
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.SlashActions]: true },
  });
  const editor = await findComposerEditor();
  const card = editor.closest('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected the composer card");
  }
  // Happy DOM has no layout: place the card, and the typed text at its
  // right-hand end, where a long line leaves the `/`.
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 900, 120),
  );
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
    new DOMRect(700, 10, 8, 20),
  ] as unknown as DOMRectList);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(700, 10, 8, 20),
  );
  const user = userEvent.setup();
  await fill(editor, "Draft /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  await waitFor(() => {
    expect(
      menu.querySelector('[data-slot="slash-panel"][data-side="end"]'),
    ).not.toBeNull();
  });

  // The second level opens on the left, so Left enters it and Right leaves.
  await user.keyboard("{ArrowUp}{ArrowUp}");
  expect(menuButton("Workflows")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowLeft}");
  expect(menuButton("/axiom-red")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowRight}");
  expect(menuButton("Workflows")).toHaveAttribute("data-active", "true");
});

test("A slash typed in the composer's left half keeps the menu at the left edge", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  const { menu } = await openSlashActions();
  await waitFor(() => {
    expect(menuButton("Workflows")).toBeInTheDocument();
  });
  expect(
    menu.querySelector('[data-slot="slash-panel"][data-side="start"]'),
  ).not.toBeNull();
});
