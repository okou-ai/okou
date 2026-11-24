import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { workflowsCollectionContract } from "@okouai/api-contracts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  composerWorkflow,
  findComposerEditor,
  createChatComposerHelpers,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "../../../signals/chat-page/workflow-prompt-action.ts";

const context = testContext();
const { mockBillingCapabilities, mockPersonalModelRoutes } =
  createChatComposerHelpers(context);

const WORKFLOW_NAME = "axiom-red";
const SECOND_WORKFLOW_NAME = "axiom-status";
const THIRD_WORKFLOW_NAME = "axiom-traces";
const THREAD_ID = "b0000000-0000-4000-a000-000000000900";
const HOME_PATH = `/?compose=1`;
const COMPOSER_PATHS = [`/chats/${THREAD_ID}`, HOME_PATH] as const;

function setupModels(): void {
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
    return respond(200, [
      composerWorkflow(
        WORKFLOW_NAME,
        "Query Axiom for RED metrics, latency percentiles, and error rates.",
      ),
      composerWorkflow(SECOND_WORKFLOW_NAME, "Check Axiom service status"),
      composerWorkflow(THIRD_WORKFLOW_NAME, "Inspect Axiom traces"),
    ]);
  });
}

async function openSlashMenu(
  query = "",
  path = HOME_PATH,
  slashActions = false,
  workflowDescription?: string,
): Promise<void> {
  setupModels();
  if (workflowDescription) {
    context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
      return respond(200, [
        composerWorkflow(WORKFLOW_NAME, workflowDescription),
      ]);
    });
  }
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.SlashActions]: slashActions },
  });
  await fill(await findComposerEditor(), `Draft /${query}`);
  await screen.findByTestId("slash-workflow-menu");
}

function slashRowLabel(button: HTMLElement): string | undefined {
  const label =
    button.querySelector('[data-slot="slash-workflow-name"]') ?? button;
  return label.textContent?.replace(/\s+/gu, " ").trim();
}

function querySlashButton(name: string): HTMLElement | null {
  return (
    queryAllByRoleFast(
      "button",
      screen.getByTestId("slash-workflow-menu"),
    ).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        slashRowLabel(candidate) === name
      );
    }) ?? null
  );
}

function slashButton(name: string): HTMLElement {
  const result = querySlashButton(name);
  if (!result) {
    throw new Error(`Expected slash panel button ${name}`);
  }
  return result;
}

test.each(["网站", "ウェブサイト", "cafe\u0301"])(
  "Unicode query %s finds a workflow description and preserves the surrounding draft",
  async (query) => {
    const user = userEvent.setup({ delay: null });
    await openSlashMenu("", HOME_PATH, false, `Review ${query} reports`);
    const editor = await findComposerEditor();
    await user.keyboard(query);
    expect(editor.textContent).toBe(`Draft /${query}`);
    const workflow = await waitFor(() => {
      return slashButton(`/${WORKFLOW_NAME}`);
    });
    await user.click(workflow);
    await waitFor(() => {
      expect(editor).toHaveTextContent(`Draft /${WORKFLOW_NAME}`);
    });
    expect(editor).toHaveFocus();
  },
);

test("Enter keeps the keyboard selection while another workflow is hovered", async () => {
  const user = userEvent.setup();
  await openSlashMenu("axi");
  const editor = await findComposerEditor();
  const workflow = await waitFor(() => {
    return slashButton(`/${WORKFLOW_NAME}`);
  });
  await user.keyboard("{ArrowDown}");
  await user.pointer({
    target: workflow,
    coords: { clientX: 10, clientY: 10 },
  });
  await user.pointer({
    target: workflow,
    coords: { clientX: 12, clientY: 10 },
  });
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(editor).toHaveTextContent(`/${SECOND_WORKFLOW_NAME}`);
  });
  expect(editor).not.toHaveTextContent(`/${WORKFLOW_NAME}`);
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("Clicking a workflow activates the pointer target", async () => {
  const user = userEvent.setup();
  await openSlashMenu("axi");
  const editor = await findComposerEditor();
  const workflow = await waitFor(() => {
    return slashButton(`/${WORKFLOW_NAME}`);
  });
  await user.keyboard("{ArrowDown}");
  await user.click(workflow);
  await waitFor(() => {
    expect(editor).toHaveTextContent(`/${WORKFLOW_NAME}`);
  });
  expect(editor).not.toHaveTextContent(`/${SECOND_WORKFLOW_NAME}`);
  expect(editor).toHaveFocus();
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("The panel emphasizes the typed query inside a workflow name", async () => {
  await openSlashMenu("axi");
  const menu = screen.getByTestId("slash-workflow-menu");
  await waitFor(() => {
    expect(
      menu.querySelector('[data-slot="workflow-query-match"]'),
    ).toHaveTextContent("axi");
  });
  expect(slashButton(`/${WORKFLOW_NAME}`)).toHaveTextContent(
    `/${WORKFLOW_NAME}`,
  );
});

test("Workflow search hides unmatched workflows and restores matching results", async () => {
  await openSlashMenu("axi");
  await waitFor(() => {
    return slashButton(`/${WORKFLOW_NAME}`);
  });
  await fill(await findComposerEditor(), "Draft /zzz");
  const menu = screen.getByTestId("slash-workflow-menu");
  await waitFor(() => {
    expect(within(menu).queryByText("Workflows")).not.toBeInTheDocument();
  });
  expect(querySlashButton(`/${WORKFLOW_NAME}`)).toBeNull();
  await fill(await findComposerEditor(), "Draft /axi");
  const matchingMenu = await screen.findByTestId("slash-workflow-menu");
  await expect(
    within(matchingMenu).findByText("Workflows"),
  ).resolves.toBeInTheDocument();
  expect(slashButton(`/${WORKFLOW_NAME}`)).toBeInTheDocument();
});

function slashMenuButtonNames(): (string | undefined)[] {
  return queryAllByRoleFast(
    "button",
    screen.getByTestId("slash-workflow-menu"),
  ).map(slashRowLabel);
}

test.each(COMPOSER_PATHS)(
  "Mobile slash suggestions at %s show capabilities before Workflows and navigate in visual order",
  async (path) => {
    context.mocks.browser.matchMedia(false);
    const user = userEvent.setup();
    await openSlashMenu("", path);
    const editor = await findComposerEditor();
    await waitFor(() => {
      expect(slashMenuButtonNames()).toStrictEqual([
        "Find people",
        "Research",
        "Create",
        "Workflow",
        `/${WORKFLOW_NAME}`,
        `/${SECOND_WORKFLOW_NAME}`,
        `/${THIRD_WORKFLOW_NAME}`,
      ]);
    });
    expect(slashButton(`/${WORKFLOW_NAME}`)).toHaveTextContent(
      `/${WORKFLOW_NAME} Query Axiom for RED metrics`,
    );
    expect(slashButton(`/${WORKFLOW_NAME}`)).not.toHaveTextContent(
      "latency percentiles",
    );
    expect(editor).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(slashButton("Find people")).toHaveAttribute("data-active", "true");
    await user.keyboard("{ArrowDown>6/}");
    expect(slashButton(`/${THIRD_WORKFLOW_NAME}`)).toHaveAttribute(
      "data-active",
      "true",
    );
    await user.keyboard("{ArrowUp}");
    expect(slashButton(`/${SECOND_WORKFLOW_NAME}`)).toHaveAttribute(
      "data-active",
      "true",
    );
    await user.keyboard("{ArrowUp>3/}{Enter}");
    await screen.findByRole("group", { name: "Presentation templates" });
    expect(editor).toHaveTextContent(/^Draft\s*$/u);
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  },
);

test.each(COMPOSER_PATHS)(
  "Desktop slash suggestions at %s keep capability actions nearest the composer",
  async (path) => {
    context.mocks.browser.matchMedia(true);
    const user = userEvent.setup();
    await openSlashMenu("", path);
    await waitFor(() => {
      expect(slashMenuButtonNames()).toStrictEqual([
        `/${WORKFLOW_NAME}`,
        `/${SECOND_WORKFLOW_NAME}`,
        `/${THIRD_WORKFLOW_NAME}`,
        "Workflow",
        "Create",
        "Research",
        "Find people",
      ]);
    });
    expect(screen.getByTestId("slash-workflow-menu")).toHaveAttribute(
      "data-side",
      "top",
    );
    await user.keyboard("{ArrowUp}");
    expect(slashButton("Find people")).toHaveAttribute("data-active", "true");
    await user.keyboard("{ArrowUp}");
    expect(slashButton("Research")).toHaveAttribute("data-active", "true");
  },
);

test.each([
  { desktop: true, keys: "{ArrowUp>5/}", workflow: THIRD_WORKFLOW_NAME },
  { desktop: false, keys: "{ArrowDown>5/}", workflow: WORKFLOW_NAME },
])(
  "Keyboard navigation crosses from capability actions into workflows with desktop=$desktop",
  async ({ desktop, keys, workflow }) => {
    context.mocks.browser.matchMedia(desktop);
    await openSlashMenu("", `/chats/${THREAD_ID}`);
    await waitFor(() => {
      return slashButton(`/${WORKFLOW_NAME}`);
    });
    const user = userEvent.setup();
    await user.keyboard(keys);
    expect(slashButton(`/${workflow}`)).toHaveAttribute("data-active", "true");
    await user.keyboard("{Tab}");
    await expect(findComposerEditor()).resolves.toHaveTextContent(
      `Draft /${workflow}`,
    );
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  },
);

async function openManyWorkflows(): Promise<HTMLElement> {
  setupModels();
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(
      200,
      Array.from({ length: 12 }, (_, index) => {
        return composerWorkflow(`daily-${String(index + 1)}`, "Daily workflow");
      }),
    );
  });
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.SlashActions]: false },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(slashButton("Show 8 more")).toBeInTheDocument();
  });
  return editor;
}

function manageWorkflowsLink(): HTMLElement | undefined {
  return queryAllByRoleFast(
    "link",
    screen.getByTestId("slash-workflow-menu"),
  ).find((candidate) => {
    return candidate.textContent?.trim() === "Manage workflows";
  });
}

test.each([true, false])(
  "The workflow overview expands without losing its selectable workflows with desktop=%s",
  async (desktop) => {
    context.mocks.browser.matchMedia(desktop);
    const user = userEvent.setup();
    const editor = await openManyWorkflows();
    expect(querySlashButton("/daily-9")).toBeNull();
    expect(slashButton("Create")).toBeInTheDocument();
    expect(querySlashButton("New workflow")).toBeNull();
    const collapsed = slashMenuButtonNames();
    const showMoreAt = collapsed.indexOf("Show 8 more");
    expect(collapsed[showMoreAt - 1]).toBe("/daily-12");
    await user.click(slashButton("Show 8 more"));
    expect(editor).toHaveFocus();
    expect(editor).toHaveTextContent("Draft /");
    expect(querySlashButton("Show 8 more")).toBeNull();
    const expanded = slashMenuButtonNames();
    expect(expanded[showMoreAt]).toBe("/daily-2");
    expect(expanded.indexOf("New workflow")).toBe(
      expanded.indexOf("/daily-9") + 1,
    );
    expect(manageWorkflowsLink()).toBeInTheDocument();
    await user.click(slashButton("/daily-12"));
    expect(editor).toHaveTextContent("Draft /daily-12");
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  },
);

test("Desktop arrow navigation passes Show more without revealing hidden workflows", async () => {
  context.mocks.browser.matchMedia(true);
  const user = userEvent.setup();
  await openManyWorkflows();
  await user.keyboard("{ArrowDown>5/}");
  expect(slashButton("Show 8 more")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowDown}");
  expect(slashButton("Workflow")).toHaveAttribute("data-active", "true");
  expect(querySlashButton("/daily-2")).toBeNull();
  await user.keyboard("{ArrowDown}");
  expect(slashButton("Create")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowUp>2/}");
  expect(slashButton("Show 8 more")).toHaveAttribute("data-active", "true");
  expect(querySlashButton("/daily-2")).toBeNull();
});

test.each([true, false])(
  "Keyboard navigation selects Show more without expanding until activation with desktop=%s",
  async (desktop) => {
    context.mocks.browser.matchMedia(desktop);
    const user = userEvent.setup();
    const editor = await openManyWorkflows();
    await user.keyboard(desktop ? "{ArrowDown>4/}" : "{ArrowDown>8/}");
    expect(slashButton("/daily-12")).toHaveAttribute("data-active", "true");
    expect(querySlashButton("/daily-2")).toBeNull();
    await user.keyboard("{ArrowDown}");
    expect(slashButton("Show 8 more")).toHaveAttribute("data-active", "true");
    expect(slashButton("Show 8 more")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(querySlashButton("/daily-2")).toBeNull();
    expect(editor).toHaveFocus();
    expect(editor).toHaveTextContent(/^Draft \/$/u);
    await user.keyboard("{ArrowUp}");
    expect(slashButton("/daily-12")).toHaveAttribute("data-active", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(slashButton("/daily-2")).toHaveAttribute("data-active", "true");
    expect(querySlashButton("Show 8 more")).toBeNull();
    expect(editor).toHaveFocus();
    expect(editor).toHaveTextContent(/^Draft \/$/u);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(editor).toHaveTextContent("Draft /daily-3");
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
    await fill(editor, "Draft /");
    expect(slashButton("Show 8 more")).toBeInTheDocument();
    expect(querySlashButton("/daily-9")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
    await fill(editor, "Draft /");
    expect(slashButton("Show 8 more")).toBeInTheDocument();
    expect(querySlashButton("/daily-9")).toBeNull();
    await fill(editor, "Draft /daily");
    expect(querySlashButton("Show 8 more")).toBeNull();
    expect(querySlashButton("New workflow")).toBeNull();
    expect(slashButton("/daily-12")).toBeInTheDocument();
  },
);

test("New workflow writes the create-workflow request where the slash was", async () => {
  const user = userEvent.setup();
  const editor = await openManyWorkflows();
  await user.click(slashButton("Show 8 more"));
  await user.click(slashButton("New workflow"));
  await waitFor(() => {
    expect(editor).toHaveTextContent(
      `Draft ${CREATE_WORKFLOW_WITH_CHAT_PROMPT}`,
    );
  });
  expect(editor).not.toHaveTextContent("/");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("Manage workflows opens the Workflows page", async () => {
  const user = userEvent.setup();
  await openManyWorkflows();
  await user.click(slashButton("Show 8 more"));
  const manage = manageWorkflowsLink();
  if (!manage) {
    throw new Error("Expected the Manage workflows link");
  }
  expect(manage).toHaveAttribute("href", "/workflows");
  await user.click(manage);
  await waitFor(() => {
    expect(window.location.pathname).toBe("/workflows");
  });
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});
