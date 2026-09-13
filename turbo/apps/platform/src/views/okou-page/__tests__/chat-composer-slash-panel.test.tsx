import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { workflowsCollectionContract } from "@okouai/api-contracts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  AGENT_ID,
  context,
  expectInlineTemplateInComposer,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
  workflowSummary,
} from "./chat-composer-test-helpers.ts";

const WORKFLOW_NAME = "axiom-red";

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
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return respond(200, [
      {
        ...workflowSummary({
          name: WORKFLOW_NAME,
          agentId: AGENT_ID,
          displayName: null,
          description: "Query Axiom for RED metrics",
        }),
        visibility: "public",
        shadowedBy: null,
      },
    ]);
  });
}

async function openSlashMenu(panel: boolean): Promise<void> {
  setupModels();
  mockChatLifecycle(context);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerCreateCommands]: true,
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: panel,
    },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /");
  await screen.findByTestId("slash-workflow-menu");
}

function detailPane(): HTMLElement | null {
  return document.querySelector('[data-slot="slash-template-detail"]');
}

function slashButton(name: string): HTMLElement {
  const menu = screen.getByTestId("slash-workflow-menu");
  const result = queryAllByRoleFast("button", menu).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!result) {
    throw new Error(`Expected slash panel button ${name}`);
  }
  return result;
}

test("The slash menu keeps its flat Create group until the panel switch is on", async () => {
  await openSlashMenu(false);
  expect(document.querySelector('[data-slot="slash-panel"]')).toBeNull();
  expect(detailPane()).toBeNull();
  expect(slashButton("Create")).toBeInTheDocument();
});

test("The slash panel previews the highlighted type's covers", async () => {
  await openSlashMenu(true);
  const pane = detailPane();
  if (!pane) {
    throw new Error("Expected the detail pane");
  }
  // The first row is highlighted when the panel opens, and slides is the only
  // row that can be highlighted without moving.
  expect(pane).toHaveAttribute("data-category", "slides");
  expect(
    within(pane).getByText(
      `${String(PRESENTATION_TEMPLATE_PICKER_ITEMS.length)} templates`,
    ),
  ).toBeInTheDocument();
  const [first] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first) {
    throw new Error("Expected a presentation template");
  }
  expect(within(pane).getByText(first.title)).toBeInTheDocument();
});

test("The pane carries more than one row of covers, so later templates are reachable", async () => {
  await openSlashMenu(true);
  const pane = detailPane();
  if (!pane) {
    throw new Error("Expected the detail pane");
  }
  // A template past the first row proves the pane scrolls its covers rather
  // than showing the single row a fixed-height pane could hold.
  const later = PRESENTATION_TEMPLATE_PICKER_ITEMS[7];
  if (!later) {
    throw new Error("Expected an eighth presentation template");
  }
  expect(within(pane).getByText(later.title)).toBeInTheDocument();
});

test("Highlighting a website row swaps the pane to the website catalog", async () => {
  const user = userEvent.setup();
  await openSlashMenu(true);
  await user.hover(slashButton("Website"));
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });
  const pane = detailPane();
  if (!pane) {
    throw new Error("Expected the detail pane");
  }
  expect(
    within(pane).getByText(
      `${String(WEBSITE_TEMPLATE_ITEMS.length)} templates`,
    ),
  ).toBeInTheDocument();
});

test("Highlighting a workflow closes the pane instead of leaving a stale type open", async () => {
  const user = userEvent.setup();
  await openSlashMenu(true);
  expect(detailPane()).not.toBeNull();
  await user.hover(slashButton(`/${WORKFLOW_NAME}`));
  await waitFor(() => {
    expect(detailPane()).toBeNull();
  });
});

test("The panel emphasizes the typed query inside a workflow name", async () => {
  setupModels();
  mockChatLifecycle(context);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerCreateCommands]: true,
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
    },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /axi");
  const menu = await screen.findByTestId("slash-workflow-menu");
  await waitFor(() => {
    expect(
      menu.querySelector('[data-slot="workflow-query-match"]'),
    ).toHaveTextContent("axi");
  });
  // The rest of the name is not emphasized, so the match is what stands out.
  expect(slashButton(`/${WORKFLOW_NAME}`)).toHaveTextContent(
    `/${WORKFLOW_NAME}`,
  );
});

test("Choosing a cover in the pane attaches that template without opening the picker", async () => {
  const user = userEvent.setup();
  await openSlashMenu(true);
  const [first] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first) {
    throw new Error("Expected a presentation template");
  }
  await user.click(slashButton(first.title));
  await expectInlineTemplateInComposer(first.title);
  expect(screen.queryByRole("dialog")).toBeNull();
});
