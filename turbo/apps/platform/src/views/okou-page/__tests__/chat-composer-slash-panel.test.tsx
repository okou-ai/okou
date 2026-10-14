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
import { START_PAGE_CENTRED_MEDIA_QUERY } from "../start-page-breakpoint.ts";

const WORKFLOW_NAME = "axiom-red";
const SECOND_WORKFLOW_NAME = "axiom-status";
const THIRD_WORKFLOW_NAME = "axiom-traces";
const THREAD_ID = "b0000000-0000-4000-a000-000000000900";
const COMPOSER_PATHS = [
  `/chats/${THREAD_ID}`,
  `/agents/${AGENT_ID}/chat`,
] as const;

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
  path = composerAnchored ? `/chats/${THREAD_ID}` : `/agents/${AGENT_ID}/chat`,
): Promise<void> {
  setupModels();
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await setupPage({
    context,
    path,
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

/**
 * A workflow row is named by its token; the description after it is not part
 * of what identifies the row.
 */
function slashRowLabel(button: HTMLElement): string | undefined {
  const label =
    button.querySelector('[data-slot="slash-workflow-name"]') ?? button;
  return label.textContent?.replace(/\s+/gu, " ").trim();
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
        slashRowLabel(candidate) === name
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
  expect(deckCover?.getAttribute("src")).toContain("height=234");

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
  expect(cover?.getAttribute("src")).toContain("width=416");
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

test("The workflow section is hidden when no workflows match", async () => {
  await openSlashMenu("axi");
  await waitFor(() => {
    return slashButton(`/${WORKFLOW_NAME}`);
  });

  await fill(await findComposerEditor(), "Draft /zzz");

  const menu = screen.getByTestId("slash-workflow-menu");
  await waitFor(() => {
    expect(within(menu).queryByText("Workflows")).not.toBeInTheDocument();
  });
  expect(
    within(menu).queryByText("No matching workflows"),
  ).not.toBeInTheDocument();
  expect(querySlashButton(`/${WORKFLOW_NAME}`)).toBeNull();
  expect(slashButton("Browse all templates")).toBeInTheDocument();

  await fill(await findComposerEditor(), "Draft /axi");
  const matchingMenu = await screen.findByTestId("slash-workflow-menu");
  await expect(
    within(matchingMenu).findByText("Workflows"),
  ).resolves.toBeInTheDocument();
  expect(slashButton(`/${WORKFLOW_NAME}`)).toBeInTheDocument();
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
    .map(slashRowLabel);
}

test.each(COMPOSER_PATHS)(
  "Mobile slash suggestions at %s show Make before Workflows and navigate in visual order",
  async (path) => {
    // Below `sm` the start page docks its composer to the floor like a thread.
    context.mocks.browser.matchMedia(false);
    const user = userEvent.setup();
    await openSlashMenu("", true, path);
    const editor = await findComposerEditor();
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
    // The composer-wide menu says what each workflow does after its name.
    expect(slashButton(`/${WORKFLOW_NAME}`)).toHaveTextContent(
      `/${WORKFLOW_NAME} Query Axiom for RED metrics`,
    );
    expect(
      queryAllByRoleFast(
        "button",
        screen.getByTestId("slash-workflow-menu"),
      ).filter((button) => {
        return button.dataset.active === "true";
      }),
    ).toHaveLength(0);
    expect(detailPane()).toBeNull();
    expect(editor).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(slashButton("Presentation")).toHaveAttribute("data-active", "true");
    await user.keyboard("{ArrowDown>5/}");
    expect(slashButton(`/${THIRD_WORKFLOW_NAME}`)).toHaveAttribute(
      "data-active",
      "true",
    );
    await user.keyboard("{ArrowUp}");
    expect(slashButton(`/${SECOND_WORKFLOW_NAME}`)).toHaveAttribute(
      "data-active",
      "true",
    );
    await user.keyboard("{ArrowUp>4/}{Enter}");
    await screen.findByRole("dialog");
    expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  },
);

test.each([
  {
    path: `/agents/${AGENT_ID}/chat`,
    side: "bottom",
    names: [
      "Presentation",
      "Illustration",
      "Website",
      `/${WORKFLOW_NAME}`,
      `/${SECOND_WORKFLOW_NAME}`,
      `/${THIRD_WORKFLOW_NAME}`,
      "Browse all templates",
    ],
    awayFromComposer: "{ArrowDown}",
  },
  {
    path: `/chats/${THREAD_ID}`,
    side: "top",
    names: [
      `/${WORKFLOW_NAME}`,
      `/${SECOND_WORKFLOW_NAME}`,
      `/${THIRD_WORKFLOW_NAME}`,
      "Website",
      "Illustration",
      "Presentation",
      "Browse all templates",
    ],
    awayFromComposer: "{ArrowUp}",
  },
])(
  "Desktop slash suggestions at $path open on the $side side and retain their visual order",
  async ({ path, side, names, awayFromComposer }) => {
    context.mocks.browser.matchMedia((query) => {
      return (
        query === START_PAGE_CENTRED_MEDIA_QUERY ||
        query === SIDEBAR_DESKTOP_MEDIA_QUERY
      );
    });
    const user = userEvent.setup();
    await openSlashMenu("", true, path);
    await waitFor(() => {
      expect(slashMenuButtonNames()).toStrictEqual(names);
    });
    expect(screen.getByTestId("slash-workflow-menu")).toHaveAttribute(
      "data-side",
      side,
    );
    await user.keyboard(awayFromComposer);
    expect(slashButton("Presentation")).toHaveAttribute("data-active", "true");
    await user.keyboard(awayFromComposer);
    expect(slashButton("Illustration")).toHaveAttribute("data-active", "true");
  },
);

test.each([
  { desktop: true, keys: "{ArrowUp>4/}", workflow: THIRD_WORKFLOW_NAME },
  { desktop: false, keys: "{ArrowDown>4/}", workflow: WORKFLOW_NAME },
])(
  "Keyboard navigation crosses from categories into workflows with desktop=$desktop",
  async ({ desktop, keys, workflow }) => {
    context.mocks.browser.matchMedia(desktop);
    await openSlashMenu("", true);
    await waitFor(() => {
      return slashButton(`/${WORKFLOW_NAME}`);
    });
    const user = userEvent.setup();
    await user.keyboard(keys);
    expect(slashButton(`/${workflow}`)).toHaveAttribute("data-active", "true");
    await user.keyboard("{Tab}");
    const editor = await findComposerEditor();
    expect(editor).toHaveTextContent(`Draft /${workflow}`);
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
    featureSwitches: { [FeatureSwitchKey.ComposerAnchoredSuggestions]: true },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(slashButton("Show all workflows")).toBeInTheDocument();
  });
  return editor;
}

test.each([true, false])(
  "The workflow overview expands without losing its selectable workflows with desktop=%s",
  async (desktop) => {
    context.mocks.browser.matchMedia(desktop);
    const user = userEvent.setup();
    const editor = await openManyWorkflows();
    expect(querySlashButton("/daily-9")).toBeNull();
    expect(slashButton("Website")).toBeInTheDocument();
    expect(slashButton("Browse all templates")).toBeInTheDocument();

    await user.click(slashButton("Show all workflows"));

    expect(editor).toHaveFocus();
    expect(editor).toHaveTextContent("Draft /");
    expect(querySlashButton("Show all workflows")).toBeNull();
    await user.click(slashButton("/daily-12"));
    expect(editor).toHaveTextContent("Draft /daily-12");
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  },
);

test("Keyboard navigation keeps workflows collapsed until the ellipsis is activated", async () => {
  const user = userEvent.setup();
  const editor = await openManyWorkflows();

  await user.keyboard("{ArrowDown>5/}");

  expect(slashButton("Show all workflows")).toHaveAttribute(
    "data-active",
    "true",
  );
  expect(slashButton("Show all workflows")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(querySlashButton("/daily-2")).toBeNull();
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent(/^Draft \/$/);

  await user.keyboard("{ArrowDown}");
  expect(slashButton("Website")).toHaveAttribute("data-active", "true");
  expect(querySlashButton("/daily-2")).toBeNull();
  await user.keyboard("{ArrowUp>2/}");
  expect(slashButton("/daily-12")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowDown}");
  expect(slashButton("Show all workflows")).toHaveAttribute(
    "data-active",
    "true",
  );

  await user.keyboard("{Enter}");
  expect(slashButton("/daily-2")).toHaveAttribute("data-active", "true");
  expect(querySlashButton("Show all workflows")).toBeNull();
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent(/^Draft \/$/);
  await user.keyboard("{ArrowDown}");
  expect(slashButton("/daily-3")).toHaveAttribute("data-active", "true");
  await user.keyboard("{Enter}");
  expect(editor).toHaveTextContent("Draft /daily-3");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();

  await fill(editor, "Draft /");
  await user.keyboard("{Escape}");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  await fill(editor, "Draft /");
  expect(slashButton("Show all workflows")).toBeInTheDocument();
  expect(querySlashButton("/daily-9")).toBeNull();

  await fill(editor, "Draft /daily");
  expect(querySlashButton("Show all workflows")).toBeNull();
  expect(slashButton("/daily-12")).toBeInTheDocument();
});

test.each(COMPOSER_PATHS)(
  "Composer-anchored desktop suggestions at %s embed selectable previews inside the menu",
  async (path) => {
    context.mocks.browser.matchMedia((query) => {
      return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
    });
    await openSlashMenu("", true, path);
    const menu = screen.getByTestId("slash-workflow-menu");
    expect(detailPane()).toBeNull();
    const user = userEvent.setup();
    await user.keyboard("{ArrowUp}");
    expect(
      within(menu).getByRole("region", { name: "Presentation" }),
    ).toBeInTheDocument();
    expect(flyout()).toBeNull();

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
  },
);

test.each(COMPOSER_PATHS)(
  "Composer-anchored slash suggestions at %s hide the template flyout at the mobile breakpoint and retain the picker",
  async (path) => {
    const viewport = context.mocks.browser.matchMedia((query) => {
      return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
    });
    await openSlashMenu("", true, path);
    expect(detailPane()).toBeNull();
    const user = userEvent.setup();
    await user.keyboard("{ArrowUp}");
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
    await user.click(slashButton("Illustration"));
    await screen.findByRole("dialog");
    expect(tabByText("Illustration")).toHaveAttribute("aria-selected", "true");
  },
);

test.each(COMPOSER_PATHS)(
  "Disabling composer-anchored suggestions at %s retains the original menu and mobile preview",
  async (path) => {
    context.mocks.browser.matchMedia(false);
    await openSlashMenu("", false, path);
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
    // The 260px menu has no room for a description beside the name.
    expect(slashButton(`/${WORKFLOW_NAME}`)).not.toHaveTextContent(
      "Query Axiom for RED metrics",
    );
  },
);
