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
  context,
  expectInlineTemplateInComposer,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
  tabByText,
  workflowSummary,
} from "./chat-composer-test-helpers.ts";

const WORKFLOW_NAME = "axiom-red";
const SECOND_WORKFLOW_NAME = "axiom-status";
const THIRD_WORKFLOW_NAME = "axiom-traces";

// The unfiltered menu has three category rows before the workflows.
const WORKFLOW_NAVIGATION_CASES = [
  { query: "", downCount: 4 },
  { query: "axi", downCount: 1 },
] as const;

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
      workflowSummary({
        name: SECOND_WORKFLOW_NAME,
        agentId: AGENT_ID,
        displayName: null,
        description: "Check Axiom service status",
      }),
      workflowSummary({
        name: THIRD_WORKFLOW_NAME,
        agentId: AGENT_ID,
        displayName: null,
        description: "Inspect Axiom traces",
      }),
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

test("Make lists the three types it indexes; Video and Workflow are not among them", async () => {
  await openSlashMenu();
  for (const category of ["Presentation", "Illustration", "Website"]) {
    expect(slashButton(category)).toBeInTheDocument();
  }
  expect(querySlashButton("Video")).toBeNull();
  // The agent's own workflows are listed right below Make, so a type row for
  // them would only reopen the same catalog the panel already indexes.
  expect(querySlashButton("Workflow")).toBeNull();
  expect(slashButton(`/${WORKFLOW_NAME}`)).toBeInTheDocument();
});

test("The pane carries every template in the category", async () => {
  await openSlashMenu();
  const pane = detailPane();
  if (!pane) {
    throw new Error("Expected the detail pane");
  }
  // The pane scrolls, so every template in the category is reachable.
  expect(
    pane.querySelectorAll("[data-slot='slash-template-cover']"),
  ).toHaveLength(PRESENTATION_TEMPLATE_PICKER_ITEMS.length);
  const last = PRESENTATION_TEMPLATE_PICKER_ITEMS.at(-1);
  if (!last) {
    throw new Error("Expected a presentation template");
  }
  expect(within(pane).getByText(last.title)).toBeInTheDocument();
});

test("Moving to another type opens its covers at the top", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  const scroller = document.querySelector<HTMLElement>(
    '[data-slot="slash-template-covers"]',
  );
  if (!scroller) {
    throw new Error("Expected the cover scroller");
  }
  scroller.scrollTop = 200;
  // The pane stays mounted across types, so without its own scroller per type
  // the next one would open at whatever offset this one was left at.
  expect(scroller.scrollTop).toBe(200);
  await user.hover(slashButton("Website"));
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });
  expect(
    document.querySelector<HTMLElement>('[data-slot="slash-template-covers"]')
      ?.scrollTop,
  ).toBe(0);
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

test("Hovering a workflow closes the flyout", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  expect(detailPane()).toHaveAttribute("data-category", "slides");
  await user.hover(slashButton(`/${WORKFLOW_NAME}`));
  await waitFor(() => {
    expect(detailPane()).toBeNull();
  });
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

test("Crossing the gap into the flyout does not close it", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  await user.hover(slashButton("Website"));
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });
  const panel = document.querySelector('[data-slot="slash-panel"]');
  if (!panel) {
    throw new Error("Expected the panel");
  }

  // The two cards are separate elements, so the browser reports a leave the
  // moment the pointer crosses between them — the panel has to read where it
  // is going before it hands the preview back to the keyboard.
  fireEvent.mouseOut(panel, { relatedTarget: flyout() });

  expect(detailPane()).toHaveAttribute("data-category", "website");
});

test("Leaving the panel hands the preview back to the keyboard selection", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  await user.hover(slashButton("Website"));
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });

  fireEvent.mouseOut(slashButton("Website"), {
    clientX: 300,
    clientY: 470,
    relatedTarget: document.body,
  });

  // The pointer owns the mark only while it is inside the panel.
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "slides");
  });
  expect(slashButton("Presentation")).toHaveAttribute("data-active", "true");
});

test.each(WORKFLOW_NAVIGATION_CASES)(
  "Enter keeps the keyboard selection while another workflow is hovered for query '$query'",
  async ({ query, downCount }) => {
    const user = userEvent.setup();
    await openSlashMenu(query);
    const editor = await findComposerEditor();
    const workflow = await waitFor(() => {
      return slashButton(`/${WORKFLOW_NAME}`);
    });

    await user.keyboard("{ArrowDown}".repeat(downCount));
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
  },
);

test.each(WORKFLOW_NAVIGATION_CASES)(
  "Clicking a workflow activates the pointer target for query '$query'",
  async ({ query, downCount }) => {
    const user = userEvent.setup();
    await openSlashMenu(query);
    const editor = await findComposerEditor();
    const workflow = await waitFor(() => {
      return slashButton(`/${WORKFLOW_NAME}`);
    });

    await user.keyboard("{ArrowDown}".repeat(downCount));
    await user.click(workflow);

    await waitFor(() => {
      expect(editor).toHaveTextContent(`/${WORKFLOW_NAME}`);
    });
    expect(editor).not.toHaveTextContent(`/${SECOND_WORKFLOW_NAME}`);
    expect(editor).toHaveFocus();
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  },
);

test.each(WORKFLOW_NAVIGATION_CASES)(
  "Arrow navigation continues from the keyboard selection after hover for query '$query'",
  async ({ query, downCount }) => {
    const user = userEvent.setup();
    await openSlashMenu(query);
    const editor = await findComposerEditor();
    const workflow = await waitFor(() => {
      return slashButton(`/${WORKFLOW_NAME}`);
    });

    await user.keyboard("{ArrowDown}".repeat(downCount));
    await user.hover(workflow);
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => {
      expect(editor).toHaveTextContent(`/${THIRD_WORKFLOW_NAME}`);
    });
    expect(editor).not.toHaveTextContent(`/${SECOND_WORKFLOW_NAME}`);
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  },
);

test("Tab keeps the keyboard selection after the pointer leaves the menu", async () => {
  const user = userEvent.setup();
  await openSlashMenu("axi");
  const editor = await findComposerEditor();
  const workflow = await waitFor(() => {
    return slashButton(`/${WORKFLOW_NAME}`);
  });

  await user.keyboard("{ArrowDown}");
  await user.hover(workflow);
  await user.unhover(workflow);
  await user.keyboard("{Tab}");

  await waitFor(() => {
    expect(editor).toHaveTextContent(`/${SECOND_WORKFLOW_NAME}`);
  });
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

test.each([
  { action: "Enter", expectedTab: "Presentation" },
  { action: "click", expectedTab: "Illustration" },
])(
  "$action opens the picker on the $expectedTab tab while Illustration is hovered",
  async ({ action, expectedTab }) => {
    const user = userEvent.setup();
    await openSlashMenu();
    const illustration = slashButton("Illustration");
    await user.hover(illustration);
    await waitFor(() => {
      expect(detailPane()).toHaveAttribute("data-category", "illustration");
    });

    if (action === "click") {
      await user.click(illustration);
    } else {
      await user.keyboard("{Enter}");
    }

    await waitFor(() => {
      return screen.getByRole("dialog");
    });
    expect(tabByText(expectedTab)).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  },
);

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

test("Keyboard navigation restores its preview even at the first row boundary", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  const website = slashButton("Website");
  await user.hover(website);
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });

  await user.keyboard("{ArrowUp}");
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "slides");
  });

  await user.pointer({
    target: website,
    coords: { clientX: 12, clientY: 10 },
  });
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });
  await user.keyboard("{Enter}");
  await waitFor(() => {
    return screen.getByRole("dialog");
  });
  expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
});

test("Leaving the panel restores the keyboard-selected category preview", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  const website = slashButton("Website");
  await user.hover(website);
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });

  await user.unhover(website);
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "slides");
  });
});

test("Changing the slash query resets the pointer preview to the filtered selection", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  const editor = await findComposerEditor();
  await user.hover(slashButton("Website"));
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });

  await fill(editor, "Draft /illu");
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "illustration");
  });
  expect(slashButton("Illustration")).toBeInTheDocument();
});

test("Reopening the slash panel clears the previous pointer preview", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  await user.hover(slashButton("Website"));
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });

  await user.keyboard("{Escape}");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  await user.keyboard("{ArrowLeft}{ArrowRight}");
  await screen.findByTestId("slash-workflow-menu");
  expect(detailPane()).toHaveAttribute("data-category", "slides");
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

test("A category row stays marked while the pointer is in its covers", async () => {
  await openSlashMenu();
  const presentation = slashButton("Presentation");
  const website = slashButton("Website");
  expect(presentation).toHaveAttribute("data-active", "true");

  // Same boundary events as the test above: the pointer walks a category row
  // and then crosses into the covers it previewed, without leaving the panel.
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

  // The left column identifies the category whose covers remain on the right.
  expect(website).toHaveAttribute("data-active", "true");
  expect(presentation).not.toHaveAttribute("data-active");
  expect(detailPane()).toHaveAttribute("data-category", "website");

  const illustration = slashButton("Illustration");
  fireEvent.mouseOut(cover, { relatedTarget: illustration });
  fireEvent.mouseOver(illustration, { relatedTarget: cover });
  fireEvent.mouseMove(illustration);
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "illustration");
  });
  expect(illustration).toHaveAttribute("data-active", "true");
  expect(website).not.toHaveAttribute("data-active");

  const [firstIllustration] = ILLUSTRATION_TEMPLATE_ITEMS;
  if (!firstIllustration) {
    throw new Error("Expected an illustration template");
  }
  const illustrationCover = slashButton(firstIllustration.title);
  fireEvent.mouseOut(illustration, { relatedTarget: illustrationCover });
  fireEvent.mouseOver(illustrationCover, { relatedTarget: illustration });
  fireEvent.mouseMove(illustrationCover);
  expect(illustration).toHaveAttribute("data-active", "true");
  expect(website).not.toHaveAttribute("data-active");
  expect(detailPane()).toHaveAttribute("data-category", "illustration");
});

test("The keyboard selection is marked again once the pointer leaves", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  const presentation = slashButton("Presentation");
  const website = slashButton("Website");

  await user.hover(website);
  await waitFor(() => {
    expect(website).toHaveAttribute("data-active", "true");
  });
  expect(presentation).not.toHaveAttribute("data-active");

  await user.unhover(website);
  await waitFor(() => {
    expect(presentation).toHaveAttribute("data-active", "true");
  });
  expect(website).not.toHaveAttribute("data-active");
  expect(detailPane()).toHaveAttribute("data-category", "slides");
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

test("Activate a template cover with Space after a cancelled pointer press", async () => {
  const user = userEvent.setup({ delay: null });
  await openSlashMenu();
  const editor = await findComposerEditor();
  const [template] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  const cover = slashButton(template.title);
  await user.pointer({ target: cover, keys: "[MouseLeft>]" });
  expect(cover).toHaveFocus();
  expect(editor).toHaveTextContent("Draft /");
  expect(screen.getByTestId("slash-workflow-menu")).toBeInTheDocument();
  // Cancel the button press within the popup. Releasing outside the whole
  // suggestion tree may dismiss it and no longer leaves a keyboard target.
  await user.pointer({
    target: screen.getByRole("dialog", { name: "Presentation" }),
    keys: "[/MouseLeft]",
  });
  await user.pointer({ target: cover, keys: "[MouseRight]" });
  expect(editor).toHaveTextContent("Draft /");

  await user.keyboard(" ");
  await expectInlineTemplateInComposer(template.title);
  expect(editor).not.toHaveTextContent("Draft /");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  await waitFor(() => {
    expect(editor).toHaveFocus();
  });
});

test("Escape from a focused template cover dismisses the slash menu", async () => {
  const user = userEvent.setup({ delay: null });
  await openSlashMenu();
  const editor = await findComposerEditor();
  const [template] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  const cover = slashButton(template.title);
  await user.pointer({ target: cover, keys: "[MouseLeft>]" });
  // Cancel the button press within the popup. Releasing outside the whole
  // suggestion tree may dismiss it and no longer leaves a keyboard target.
  await user.pointer({
    target: screen.getByRole("dialog", { name: "Presentation" }),
    keys: "[/MouseLeft]",
  });
  expect(cover).toHaveFocus();

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
    expect(flyout()).toBeNull();
  });
  expect(editor).toHaveTextContent("Draft /");
  expect(editor).toHaveFocus();
  await user.keyboard("next");
  expect(editor).toHaveTextContent("Draft /next");
});
