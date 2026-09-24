import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { workflowsCollectionContract } from "@okouai/api-contracts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  AGENT_ID,
  composerWorkflow,
  context,
  expectInlineTemplateInComposer,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
  tabByText,
} from "./chat-composer-test-helpers.ts";

const WORKFLOW_NAME = "axiom-red";
const SECOND_WORKFLOW_NAME = "axiom-status";
const THIRD_WORKFLOW_NAME = "axiom-traces";

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
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [
      composerWorkflow(WORKFLOW_NAME, "Query Axiom for RED metrics"),
      composerWorkflow(SECOND_WORKFLOW_NAME, "Check Axiom service status"),
      composerWorkflow(THIRD_WORKFLOW_NAME, "Inspect Axiom traces"),
    ]);
  });
}

async function openSlashMenu(query = ""): Promise<void> {
  setupModels();
  mockChatLifecycle(context);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
    },
  });
  const editor = await findComposerEditor();
  await fill(editor, `Draft /${query}`);
  await screen.findByTestId("slash-workflow-menu");
}

function detailPane(): HTMLElement | null {
  return document.querySelector('[data-slot="slash-template-detail"]');
}

/** The flyout is portalled beside the menu, so it is a surface of its own. */
function flyout(): HTMLElement | null {
  return document.querySelector('[data-slot="slash-template-flyout"]');
}

function querySlashButton(name: string): HTMLElement | null {
  const surfaces = [screen.getByTestId("slash-workflow-menu"), flyout()];
  for (const surface of surfaces) {
    if (!surface) {
      continue;
    }
    const match = queryAllByRoleFast("button", surface).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.replace(/\s+/gu, " ").trim() === name
      );
    });
    if (match) {
      return match;
    }
  }
  return null;
}

function slashButton(name: string): HTMLElement {
  const result = querySlashButton(name);
  if (!result) {
    throw new Error(`Expected slash panel button ${name}`);
  }
  return result;
}

test("The slash panel initially previews the keyboard-selected type's covers", async () => {
  await openSlashMenu();
  const pane = detailPane();
  if (!pane) {
    throw new Error("Expected the detail pane");
  }
  // The first category is selected when the panel opens.
  expect(pane).toHaveAttribute("data-category", "slides");
  expect(flyout()).toHaveAccessibleName("Presentation");
  const [first] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first) {
    throw new Error("Expected a presentation template");
  }
  expect(within(pane).getByText(first.title)).toBeInTheDocument();
});

test("Illustration covers keep their own proportion; decks keep the 16:9 tile", async () => {
  const user = userEvent.setup();
  await openSlashMenu();

  // A deck cover really is a slide, so it still asks for the 16:9 box.
  const deckCover = detailPane()?.querySelector("img");
  expect(deckCover?.getAttribute("src")).toContain("height=158");

  await user.hover(slashButton("Illustration"));
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "illustration");
  });
  const pane = detailPane();
  if (!pane) {
    throw new Error("Expected the detail pane");
  }
  const [style] = ILLUSTRATION_TEMPLATE_ITEMS;
  if (!style) {
    throw new Error("Expected an illustration style");
  }
  const cover = pane.querySelector("img");
  // Width only: passing a 16:9 height too made the transform fit a portrait
  // style inside it, so the card received a picture far smaller than it paints.
  expect(cover?.getAttribute("src")).toContain("width=280");
  expect(cover?.getAttribute("src")).not.toContain("height=");
  // The tile declares the catalog's own ratio rather than a shared one, which
  // is what stops the artwork being cropped.
  expect(cover?.parentElement?.getAttribute("style")).toContain(
    `${String(style.width)} / ${String(style.height)}`,
  );
});

test("Hovering a website row previews the website catalog", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  await user.hover(slashButton("Website"));
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });
  const pane = detailPane();
  if (!pane) {
    throw new Error("Expected the detail pane");
  }
  expect(flyout()).toHaveAccessibleName("Website");
  expect(
    pane.querySelectorAll("[data-slot='slash-template-cover']"),
  ).toHaveLength(WEBSITE_TEMPLATE_ITEMS.length);
});

test("Arrowing to a type opens its flyout too", async () => {
  const user = userEvent.setup();
  await openSlashMenu();

  // The flyout follows the row the menu is on, and the keyboard owns that row
  // whenever the pointer is elsewhere — so it is not a hover-only surface.
  await user.keyboard("{ArrowDown}");

  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "illustration");
  });
});

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

test("Clicking Illustration opens the picker on its own tab", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  await user.click(slashButton("Illustration"));

  await waitFor(() => {
    return screen.getByRole("dialog");
  });
  expect(tabByText("Illustration")).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

// Website has no create mode, so it is the row that used to leave the menu
// standing and made the dialog it opened compete with it.
test("Clicking Website opens the picker on its own tab", async () => {
  const user = userEvent.setup();
  await openSlashMenu();

  await user.click(slashButton("Website"));

  await waitFor(() => {
    return screen.getByRole("dialog");
  });
  expect(tabByText("Website")).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("Browse all templates opens the picker", async () => {
  const user = userEvent.setup();
  await openSlashMenu();

  await user.click(slashButton("Browse all templates"));

  await waitFor(() => {
    return screen.getByRole("dialog");
  });
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("A hovered category's template stays selectable when the pointer enters its preview", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  const website = slashButton("Website");
  // user-event 14 omits relatedTarget on mouseout. Use the browser's exact
  // boundary events here so React can distinguish entering a child of the
  // panel from leaving the whole panel. Real pointer movement is also checked
  // on the PR preview.
  fireEvent.mouseOver(website);
  fireEvent.mouseMove(website);
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });
  const [first] = WEBSITE_TEMPLATE_ITEMS;
  if (!first) {
    throw new Error("Expected a website template");
  }

  const cover = slashButton(first.title);
  fireEvent.mouseOut(website, { relatedTarget: cover });
  fireEvent.mouseOver(cover, { relatedTarget: website });
  fireEvent.mouseMove(cover);
  expect(detailPane()).toHaveAttribute("data-category", "website");
  await user.click(cover);

  await expectInlineTemplateInComposer(first.title);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("The panel emphasizes the typed query inside a workflow name", async () => {
  setupModels();
  mockChatLifecycle(context);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
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
  await openSlashMenu();
  const [first] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first) {
    throw new Error("Expected a presentation template");
  }
  await user.click(slashButton(first.title));
  await expectInlineTemplateInComposer(first.title);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Choosing a cover consumes the slash token that opened the panel", async () => {
  const user = userEvent.setup();
  await openSlashMenu("pre");
  const editor = await findComposerEditor();
  const [first] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first) {
    throw new Error("Expected a presentation template");
  }

  await user.click(slashButton(first.title));

  await expectInlineTemplateInComposer(first.title);
  // The whole token goes, not only its slash, and the prose before it stays.
  expect(editor).not.toHaveTextContent("/");
  expect(editor).toHaveTextContent("Draft");
});
