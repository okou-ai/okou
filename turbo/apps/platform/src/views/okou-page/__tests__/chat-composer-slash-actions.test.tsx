import { workflowsCollectionContract } from "@okouai/api-contracts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { CREATE_AUTOMATION_CHAT_PROMPT } from "../../../signals/chat-page/workflow-prompt-action.ts";
import {
  AGENT_ID,
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
}: {
  readonly path?: string;
  readonly enabled?: boolean;
  readonly noModelChoice?: boolean;
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
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.SlashActions]: enabled },
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
        '[data-slot="slash-workflow-detail"], [data-slot="slash-templates-detail"]',
      );
    })
    .map((button) => {
      return button.textContent?.replace(/\s+/gu, " ").trim() ?? "";
    });
}

test("The bare slash leads with chat actions, then Workflows and Templates with their counts", async () => {
  const { menu } = await openSlashActions();
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
  // A new chat has nothing to rename, pin, archive or share yet.
  expect(
    names.find((name) => {
      return name.startsWith("Rename");
    }),
  ).toBeUndefined();
  // The rows name themselves; no section labels.
  expect(within(menu).queryByText("Make")).not.toBeInTheDocument();
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

test("Schedule writes the automation request where the slash was", async () => {
  const user = userEvent.setup();
  const { editor } = await openSlashActions();
  await waitFor(() => {
    return menuButton("Schedule");
  });

  await user.click(menuButton("Schedule"));

  await waitFor(() => {
    expect(editor).toHaveTextContent(`Draft ${CREATE_AUTOMATION_CHAT_PROMPT}`);
  });
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
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
