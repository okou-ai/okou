import { workflowsCollectionContract } from "@okouai/api-contracts";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  composerWorkflow,
  context,
  expectInlineTemplateInComposer,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockPersonalModelRoutes,
  tabByText,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";

const WORKFLOW_NAME = "axiom-red";
const SECOND_WORKFLOW_NAME = "axiom-status";
const THIRD_WORKFLOW_NAME = "axiom-traces";

function setupModels(): void {
  mockAgent();
  mockPersonalModelRoutes();
  mockBillingCapabilities({
    restrictedBuiltInModels: false,
  });
  context.mocks.data.userModelPreference({
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
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

async function openSlashMenu(
  query = "",
  composerAnchored = false,
): Promise<void> {
  setupModels();
  mockChatLifecycle(context);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerAnchoredSuggestions]: composerAnchored,
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

test("A query that matches no workflow says so in the workflow list", async () => {
  await openSlashMenu("axi");
  await waitFor(() => {
    return slashButton(`/${WORKFLOW_NAME}`);
  });

  await fill(await findComposerEditor(), "Draft /zzz");

  const menu = screen.getByTestId("slash-workflow-menu");
  await expect(
    within(menu).findByText("No matching workflows"),
  ).resolves.toBeInTheDocument();
  expect(querySlashButton(`/${WORKFLOW_NAME}`)).toBeNull();
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

function slashMenuButtonNames(): (string | undefined)[] {
  return queryAllByRoleFast("button", screen.getByTestId("slash-workflow-menu"))
    .filter((button) => {
      return !button.closest('[data-slot="slash-template-detail"]');
    })
    .map((button) => {
      return button.textContent?.trim();
    });
}

test("Composer-anchored slash suggestions default to the bottom candidate and navigate visually", async () => {
  const user = userEvent.setup();
  await openSlashMenu("", true);
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(slashMenuButtonNames()).toStrictEqual([
      "Browse all templates",
      `/${THIRD_WORKFLOW_NAME}`,
      `/${SECOND_WORKFLOW_NAME}`,
      `/${WORKFLOW_NAME}`,
      "Website",
      "Illustration",
      "Presentation",
    ]);
  });
  expect(slashButton("Presentation")).toHaveAttribute("data-active", "true");
  expect(editor).toHaveFocus();

  await user.keyboard("{ArrowDown}");
  expect(slashButton("Presentation")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowUp}");
  expect(slashButton("Illustration")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowDown}{Enter}");
  await screen.findByRole("dialog");
  expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("Composer-anchored slash suggestions keep the strongest match at the bottom and reset on a new query", async () => {
  setupModels();
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [
      composerWorkflow("daily-axi", "Substring match"),
      composerWorkflow("a-x-i", "Fuzzy match"),
      composerWorkflow("axiom-red", "Prefix match"),
      composerWorkflow("axi", "Exact match"),
    ]);
  });
  mockChatLifecycle(context);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ComposerAnchoredSuggestions]: true },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /axi");
  await screen.findByTestId("slash-workflow-menu");
  await waitFor(() => {
    expect(slashMenuButtonNames()).toStrictEqual([
      "Browse all templates",
      "/a-x-i",
      "/daily-axi",
      "/axiom-red",
      "/axi",
    ]);
  });
  expect(slashButton("/axi")).toHaveAttribute("data-active", "true");
  const user = userEvent.setup();
  await user.keyboard("{ArrowUp}{ArrowUp}");
  expect(slashButton("/daily-axi")).toHaveAttribute("data-active", "true");
  await fill(editor, "Draft /axiom");
  await waitFor(() => {
    expect(slashButton("/axiom-red")).toHaveAttribute("data-active", "true");
  });
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(editor).toHaveTextContent("Draft /axiom-red");
  });
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  expect(editor).toHaveFocus();
});

test("Composer-anchored keyboard navigation crosses from categories into workflows", async () => {
  await openSlashMenu("", true);
  await waitFor(() => {
    return slashButton(`/${WORKFLOW_NAME}`);
  });
  const user = userEvent.setup();
  await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
  expect(slashButton(`/${WORKFLOW_NAME}`)).toHaveAttribute(
    "data-active",
    "true",
  );
  await user.keyboard("{Tab}");
  const editor = await findComposerEditor();
  expect(editor).toHaveTextContent(`Draft /${WORKFLOW_NAME}`);
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test("Composer-anchored desktop suggestions embed selectable previews inside the menu", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  await openSlashMenu("", true);
  const menu = screen.getByTestId("slash-workflow-menu");
  expect(
    within(menu).getByRole("region", { name: "Presentation" }),
  ).toBeInTheDocument();
  expect(flyout()).toBeNull();

  const user = userEvent.setup();
  await user.keyboard("{ArrowUp}");
  expect(
    within(menu).getByRole("region", { name: "Illustration" }),
  ).toBeInTheDocument();
  const website = slashButton("Website");
  fireEvent.mouseOver(website);
  fireEvent.mouseMove(website);
  await waitFor(() => {
    expect(
      within(menu).getByRole("region", { name: "Website" }),
    ).toBeInTheDocument();
  });
  const [first] = WEBSITE_TEMPLATE_ITEMS;
  if (!first) {
    throw new Error("Expected a website template");
  }
  const cover = slashButton(first.title);
  // Use exact boundary events, as in the legacy flyout test above: user-event
  // omits relatedTarget on mouseout and cannot model this pointer handoff.
  fireEvent.mouseOut(website, { relatedTarget: cover });
  fireEvent.mouseOver(cover, { relatedTarget: website });
  expect(detailPane()).toHaveAttribute("data-category", "website");
  await user.click(cover);
  await expectInlineTemplateInComposer(first.title);
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  const editor = await findComposerEditor();
  expect(editor).toHaveFocus();
});

test("Composer-anchored slash suggestions hide the template flyout at the mobile breakpoint and retain the picker", async () => {
  const viewport = context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  await openSlashMenu("", true);
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "slides");
  });
  act(() => {
    viewport.setMatches(false);
  });
  await waitFor(() => {
    expect(detailPane()).toBeNull();
  });
  expect(flyout()).toBeNull();
  expect(slashButton("Presentation")).toHaveAttribute("data-active", "true");
  const user = userEvent.setup();
  await user.click(slashButton("Illustration"));
  await screen.findByRole("dialog");
  expect(tabByText("Illustration")).toHaveAttribute("aria-selected", "true");
});

test("Disabling composer-anchored suggestions retains the original menu and mobile preview", async () => {
  context.mocks.browser.matchMedia(false);
  await openSlashMenu("", false);
  await waitFor(() => {
    expect(slashMenuButtonNames()).toStrictEqual([
      "Presentation",
      "Illustration",
      "Website",
      `/${WORKFLOW_NAME}`,
      `/${SECOND_WORKFLOW_NAME}`,
      `/${THIRD_WORKFLOW_NAME}`,
      "Browse all templates",
    ]);
  });
  expect(slashButton("Presentation")).toHaveAttribute("data-active", "true");
  expect(detailPane()).toHaveAttribute("data-category", "slides");
  expect(flyout()).toHaveAccessibleName("Presentation");
});
