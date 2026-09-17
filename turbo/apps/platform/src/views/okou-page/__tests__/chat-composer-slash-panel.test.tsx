import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { workflowsCollectionContract } from "@okouai/api-contracts";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
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
import { mockTemplateChat } from "./chat-composer-template-gallery-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
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

// The unfiltered menu has five category rows before the workflows.
const WORKFLOW_NAVIGATION_CASES = [
  { query: "", downCount: 6 },
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

test("The slash panel initially previews the keyboard-selected type's covers", async () => {
  await openSlashMenu();
  const pane = detailPane();
  if (!pane) {
    throw new Error("Expected the detail pane");
  }
  // The first category is selected when the panel opens.
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
  await openSlashMenu();
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
  expect(
    within(pane).getByText(
      `${String(WEBSITE_TEMPLATE_ITEMS.length)} templates`,
    ),
  ).toBeInTheDocument();
});

test("Hovering a workflow closes the preview pane", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  expect(detailPane()).not.toBeNull();
  await user.hover(slashButton(`/${WORKFLOW_NAME}`));
  await waitFor(() => {
    expect(detailPane()).toBeNull();
  });
});

test("Hovering the Workflow type closes the preview pane", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  expect(detailPane()).not.toBeNull();
  await user.hover(slashButton("Workflow"));
  await waitFor(() => {
    expect(detailPane()).toBeNull();
  });
});

test("The closed preview pane stays closed when the panel leaves a still pointer", async () => {
  await openSlashMenu();
  const workflow = slashButton("Workflow");
  // The popover is content-width, so closing the pane narrows it. When the
  // popover has been collision-shifted against a boundary, that narrowing
  // re-pins it and the left column slides away from a pointer that never
  // moved, which the browser reports as a leave at the move's own
  // coordinates. Replayed here because jsdom has no layout to shift.
  const still = { clientX: 300, clientY: 470 };
  fireEvent.mouseOver(workflow, still);
  fireEvent.mouseMove(workflow, still);
  await waitFor(() => {
    expect(detailPane()).toBeNull();
  });

  fireEvent.mouseOut(workflow, { ...still, relatedTarget: document.body });

  expect(detailPane()).toBeNull();
  expect(slashButton("Presentation")).not.toHaveAttribute("data-active");
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
  { action: "click", expectedTab: "Video" },
])(
  "$action opens the picker on the $expectedTab tab while Video is hovered",
  async ({ action, expectedTab }) => {
    const user = userEvent.setup();
    await openSlashMenu();
    const video = slashButton("Video");
    await user.hover(video);
    await waitFor(() => {
      expect(detailPane()).toHaveAttribute("data-category", "video");
    });

    if (action === "click") {
      await user.click(video);
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

// The two rows without a create mode are the ones that used to leave the menu
// standing, so the dialog they opened had to compete with it.
test.each(["Website", "Workflow"])(
  "Clicking %s opens the picker on its own tab",
  async (category) => {
    const user = userEvent.setup();
    await openSlashMenu();

    await user.click(slashButton(category));

    await waitFor(() => {
      return screen.getByRole("dialog");
    });
    expect(tabByText(category)).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  },
);

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

  await fill(editor, "Draft /vid");
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "video");
  });
  expect(slashButton("Video")).toBeInTheDocument();
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

test("A category row keeps no mark once the pointer is in its covers", async () => {
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

  // Neither the row the pointer left nor the row it started on stays marked,
  // so the left column never argues with the covers on the right.
  expect(website).not.toHaveAttribute("data-active");
  expect(presentation).not.toHaveAttribute("data-active");
  expect(detailPane()).toHaveAttribute("data-category", "website");
});

test("The keyboard selection is marked again once the pointer leaves", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  const presentation = slashButton("Presentation");
  const website = slashButton("Website");

  await user.hover(website);
  await waitFor(() => {
    expect(presentation).not.toHaveAttribute("data-active");
  });

  await user.unhover(website);
  await waitFor(() => {
    expect(presentation).toHaveAttribute("data-active", "true");
  });
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

const IMPORT_PROMPT =
  "Analyse this deck and save its visual language as a reusable presentation template.";

function uploadedFilePart(message: UserMessageDocument) {
  const part = message.parts.find((candidate) => {
    return candidate.type === "file";
  });
  if (!part || part.type !== "file") {
    throw new Error("Imported message has no uploaded file");
  }
  return part;
}

test("Only the Presentation pane offers the deck import, and it leads the covers", async () => {
  const user = userEvent.setup();
  await openSlashMenu();
  const pane = detailPane();
  if (!pane) {
    throw new Error("Expected the detail pane");
  }
  const grid = pane.querySelector(
    '[data-slot="slash-template-import"]',
  )?.parentElement;
  expect(grid?.firstElementChild).toHaveAttribute(
    "data-slot",
    "slash-template-import",
  );
  expect(within(pane).getByLabelText("Import your own deck")).toHaveAttribute(
    "accept",
    ".pptx,.ppt,.pdf",
  );

  // A deck is a presentation, so no other category carries the control.
  await user.hover(slashButton("Website"));
  await waitFor(() => {
    expect(detailPane()).toHaveAttribute("data-category", "website");
  });
  expect(
    document.querySelector('[data-slot="slash-template-import"]'),
  ).toBeNull();
});

test("Importing a deck from the panel sends it for analysis", async () => {
  const capture = mockTemplateChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000031",
    filename: "panel-deck.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 5,
    url: "https://cdn.example.test/panel-deck.pptx",
  });
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
    },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /");
  await screen.findByTestId("slash-workflow-menu");

  await user.upload(
    screen.getByLabelText("Import your own deck"),
    new File(["deck"], "panel-deck.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
  );

  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(uploadedFilePart(capture.sentMessages[0]!).filenameSnapshot).toBe(
    "panel-deck.pptx",
  );
  expect(capture.runPrompts).toStrictEqual([IMPORT_PROMPT]);
});
