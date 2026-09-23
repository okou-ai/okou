import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  composerInlineTemplates,
  findComposerEditor,
  tabByText,
  composerModelTrigger,
} from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  context,
  createUploadedTemplate,
  mockPresentationTemplateLibrary,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

const CREATE_WORKFLOW_PROMPT =
  "Help me create a workflow for this agent. Use the workflow-setup skill, then ask me for the desired outcome, automation, and action before creating the workflow and automation.";

function button(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((item) => {
    return (
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label
    );
  });
  if (!result) {
    throw new Error(`Expected button ${label}`);
  }
  return result;
}

async function setupChips(enabled = true): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerTaskChips]: enabled,
    },
  });
  return await findComposerEditor();
}

/** The chips and the add menu are separate switches, so both are named. */
async function setupChipsWithAddMenu(chips: boolean): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerTaskChips]: chips,
      [FeatureSwitchKey.ComposerAddMenu]: true,
    },
  });
  return await findComposerEditor();
}

/** The chips and the slash panel are separate switches, so both are named. */
async function setupChipsWithSlashPanel(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerTaskChips]: true,
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
    },
  });
  return await findComposerEditor();
}

function composerCard(editor: HTMLElement): HTMLElement {
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected composer card");
  }
  return card;
}

// The selected task is one control: the chip itself removes the selection, so
// it is addressed by that action rather than by a wrapping group.
function selectedTask(editor: HTMLElement, task: string): HTMLElement {
  return button(`Remove ${task}`, composerCard(editor));
}

async function addMenuRow(
  editor: HTMLElement,
  label: string,
): Promise<HTMLElement> {
  click(button("Add", composerCard(editor)));
  const menu = await screen.findByRole("menu", { name: "Add" });
  const row = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === label;
  });
  if (!row) {
    throw new Error(`Expected the ${label} row`);
  }
  return row;
}

function templateShelf(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

function coverButtons(shelf: HTMLElement): HTMLElement[] {
  return queryAllByRoleFast("button", shelf).filter((item) => {
    return (
      item.getAttribute("aria-label")?.startsWith("Use template ") === true
    );
  });
}

test("The start page shows only task choices until one is selected", async () => {
  mockTemplateChat();
  await setupChips();
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  expect(
    queryAllByRoleFast("button", tasks).map((item) => {
      return item.textContent?.trim();
    }),
  ).toStrictEqual([
    "Workflow",
    "Presentation",
    "Image",
    "Website",
    "Visualization",
  ]);
  expect(
    screen.queryByRole("group", { name: "Ideas to get started" }),
  ).toBeNull();
  expect(
    screen.queryByRole("group", { name: "Presentation templates" }),
  ).toBeNull();
});

test("A task moves into the composer and can be removed without losing the draft", async () => {
  mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Keep my draft");
  click(
    button(
      "Presentation",
      screen.getByRole("group", { name: "Choose a task" }),
    ),
  );
  const selected = selectedTask(editor, "Presentation");
  expect(selected).toBeVisible();
  expect(screen.queryByRole("group", { name: "Choose a task" })).toBeNull();
  expect(editor).toHaveTextContent("Keep my draft");
  await screen.findByRole("group", { name: "Presentation templates" });
  click(selected);
  await screen.findByRole("group", { name: "Choose a task" });
  expect(
    screen.queryByRole("group", { name: "Presentation templates" }),
  ).toBeNull();
  expect(editor).toHaveTextContent("Keep my draft");
});

test("The original start cards remain when task chips are disabled", async () => {
  mockTemplateChat();
  await setupChips(false);
  expect(screen.getByTestId("start-cards")).toBeInTheDocument();
  expect(
    document.querySelector('[data-slot="workflow-recommendation-tile"]'),
  ).toBeNull();
  expect(screen.queryByText("Browse workflows")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Tasks to get started" }),
  ).toBeNull();
});

test("A send carries the task and its slide count into the thread it opens", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  click(
    button(
      "Presentation",
      screen.getByRole("group", { name: "Choose a task" }),
    ),
  );
  click(screen.getByRole("combobox", { name: "Slide count" }));
  click(await screen.findByRole("option", { name: "16–20 slides" }));
  await fill(editor, "Our launch deck");
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 16-20"),
  });
  // The send lands in a composer of its own, one that has never been told what
  // the run is making, so the selection has to travel with it.
  const threadEditor = await findComposerEditor();
  expect(selectedTask(threadEditor, "Presentation")).toBeVisible();
  expect(
    screen.getByRole("combobox", { name: "Slide count" }),
  ).toHaveTextContent("16–20 slides");
});

test("Visualization preferences are interactive and are sent as agent-only context", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Explain the quarterly results");
  click(
    button(
      "Visualization",
      screen.getByRole("group", { name: "Choose a task" }),
    ),
  );
  const panel = await screen.findByRole("region", {
    name: "Visualization options",
  });
  const outputPicker = within(panel).getByRole("group", {
    name: "Output format",
  });
  const website = button("Website", outputPicker);
  click(website);
  expect(website).toHaveAttribute("aria-pressed", "true");
  click(website);
  expect(website).toHaveAttribute("aria-pressed", "false");
  click(website);

  const chartPicker = within(panel).getByRole("group", {
    name: "Preferred charts",
  });
  click(button("Bar chart", chartPicker));
  click(button("Sankey diagram", chartPicker));

  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual(["Explain the quarterly results"]);
  const additionalInfo = capture.sentMessages[0]?.parts.find((part) => {
    return part.type === "additional_info";
  });
  expect(additionalInfo).toMatchObject({
    type: "additional_info",
    text: expect.stringContaining("- Preferred output format: website"),
  });
  expect(additionalInfo).toMatchObject({
    text: expect.stringContaining("- Preferred chart types: bar, sankey"),
  });
});

test("Image enters and submits the existing create mode with only the chip switch enabled", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  await fill(editor, "My launch next week");
  click(button("Image", tasks));
  await waitFor(() => {
    expect(selectedTask(editor, "Image")).toBeVisible();
  });
  expect(capture.sentMessages).toHaveLength(0);
  click(button("Send"));
  await waitFor(() => {
    expect(capture.runPrompts).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual(["My launch next week"]);
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create an image."),
  });
});

async function setupTaskChangesWithUpload() {
  const capture = mockTemplateChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000021",
    filename: "brief.txt",
    contentType: "text/plain",
    size: 5,
    url: "https://cdn.example.test/brief.txt",
  });
  const user = userEvent.setup({ delay: null });
  const editor = await setupChips();
  await fill(editor, "Keep my draft");
  const upload = document.querySelector<HTMLInputElement>(
    'input[type="file"][multiple]',
  );
  if (!upload) {
    throw new Error("Expected composer upload input");
  }
  await user.upload(
    upload,
    new File(["brief"], "brief.txt", { type: "text/plain" }),
  );
  await screen.findByText("brief.txt");
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  click(button("Image", tasks));
  await screen.findByRole("combobox", { name: "Image models" });
  click(selectedTask(editor, "Image"));
  const restoredTasks = await screen.findByRole("group", {
    name: "Choose a task",
  });
  click(button("Presentation", restoredTasks));
  const slideCount = await screen.findByRole("combobox", {
    name: "Slide count",
  });
  click(slideCount);
  click(await screen.findByRole("option", { name: "16–20 slides" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Slide count" }),
    ).toHaveTextContent("16–20 slides");
  });
  click(selectedTask(editor, "Presentation"));
  await composerModelTrigger("Claude Sonnet 4.6");
  expect(editor).toHaveTextContent("Keep my draft");
  expect(screen.getByText("brief.txt")).toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
  return { capture, editor };
}

test("Toggling a task off sends the ordinary draft and uploaded file", async () => {
  const { capture } = await setupTaskChangesWithUpload();
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual(["Keep my draft"]);
  expect(capture.sentMessages[0]?.parts).toContainEqual(
    expect.objectContaining({ type: "file", filenameSnapshot: "brief.txt" }),
  );
});

test.each([
  {
    task: "Image",
    first: "Put my product in a new scene",
    second: "Make a headshot I can use at work",
    firstPrompt:
      "Put my product in a new scene. I will add a product photo; help me choose a setting while keeping the product itself consistent.",
    secondPrompt:
      "Turn a photo of me into a professional headshot. Keep my identity recognizable and help me choose a natural background and lighting.",
  },
])(
  "A second $task idea rewrites the first prompt instead of stacking one after it",
  async ({ task, first, second, firstPrompt, secondPrompt }) => {
    mockTemplateChat();
    const editor = await setupChips();
    click(button(task, screen.getByRole("group", { name: "Choose a task" })));
    const ideas = await screen.findByRole("group", {
      name: "Ideas to get started",
    });
    await fill(editor, "Keep this context");
    click(button(first, ideas));
    await waitFor(() => {
      expect(editor.textContent).toBe(`Keep this context\n${firstPrompt}`);
    });
    click(button(second, ideas));
    await waitFor(() => {
      expect(editor.textContent).toBe(`Keep this context\n${secondPrompt}`);
    });
  },
);

/**
 * A slash panel row opens the picker as well as selecting the task, and the
 * open dialog hides the composer from the accessibility tree. Close it to read
 * what the row left behind.
 */
async function closeTemplatePicker(): Promise<void> {
  click(button("Close", await screen.findByRole("dialog")));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
}

test("The /ill slash command selects Image", async () => {
  mockTemplateChat();
  const editor = await setupChipsWithSlashPanel();
  const user = userEvent.setup({ delay: null });
  await fill(editor, "A quiet garden /ill");
  const menu = await screen.findByTestId("slash-workflow-menu");
  // The panel's rows act on mousedown, which only a full pointer sequence fires.
  await user.click(button("Illustration", menu));
  await closeTemplatePicker();
  await waitFor(() => {
    expect(selectedTask(editor, "Image")).toBeVisible();
  });
  expect(screen.queryByRole("group", { name: "Choose a task" })).toBeNull();
  expect(editor).toHaveTextContent("A quiet garden");
  expect(editor).not.toHaveTextContent("/ill");
});

// A cover brings its template along instead of opening the picker, but lands
// the composer in the same task its category row would.
test("A slash panel cover attaches its template and lands on its task", async () => {
  mockTemplateChat();
  const editor = await setupChipsWithSlashPanel();
  await fill(editor, "A launch page /web");
  await screen.findByTestId("slash-workflow-menu");
  // The covers float beside the index in their own flyout, so they are not
  // inside the menu's own box.
  const pane = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-slot="slash-template-flyout"]',
    );
    if (!element) {
      throw new Error("Expected the template flyout");
    }
    return element;
  });
  const [first] = WEBSITE_TEMPLATE_ITEMS;
  if (!first) {
    throw new Error("Expected a website template");
  }
  const user = userEvent.setup({ delay: null });

  await user.click(button(`Use template ${first.title}`, pane));

  await waitFor(() => {
    expect(selectedTask(editor, "Website")).toBeVisible();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(editor).toHaveTextContent("A launch page");
  expect(editor).not.toHaveTextContent("/web");
});

test("A presentation suggestion inserts a canonical template and preserves the prompt", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Explain our product launch");
  click(
    button(
      "Presentation",
      screen.getByRole("group", { name: "Choose a task" }),
    ),
  );
  const templates = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  expect(
    within(templates).getByLabelText("Import your own deck"),
  ).toHaveAttribute("accept", ".pptx,.ppt,.pdf");
  // The rail carries the whole catalog, so the row is no longer a top-three cut.
  for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
    expect(button(item.title, templates)).toBeInTheDocument();
  }
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
  click(button(template.title, templates));
  await waitFor(() => {
    expect(editor).toHaveTextContent(template.title);
  });
  expect(editor).toHaveTextContent("Explain our product launch");
  const slideCount = screen.getByRole("combobox", { name: "Slide count" });
  expect(slideCount).toHaveTextContent("8–12 slides");
  click(slideCount);
  click(await screen.findByRole("option", { name: "16–20 slides" }));
  await waitFor(() => {
    expect(slideCount).toHaveTextContent("16–20 slides");
  });
  expect(capture.sentMessages).toHaveLength(0);
  click(button("Send"));
  await waitFor(() => {
    expect(capture.selectedTemplates).toHaveLength(1);
  });
  expect(capture.selectedTemplates[0]).toMatchObject({
    type: "presentation",
    selection: {
      templateId: template.templateId,
      previewUrl: template.embedUrl,
    },
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 16-20"),
  });
});

test("Uploaded presentation suggestions use the existing template reference", async () => {
  const capture = mockTemplateChat();
  const deck = createUploadedTemplate({
    id: "81000000-0000-4000-a000-000000000022",
    title: "My brand deck",
    canManage: true,
  });
  mockPresentationTemplateLibrary([
    deck,
    ...[24, 25, 26].map((index) => {
      return createUploadedTemplate({
        id: `81000000-0000-4000-a000-0000000000${index}`,
        title: `My brand deck ${index}`,
        canManage: true,
      });
    }),
  ]);
  const editor = await setupChips();
  click(
    button(
      "Presentation",
      screen.getByRole("group", { name: "Choose a task" }),
    ),
  );
  const templates = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  await within(templates).findByText("My brand deck");
  // Every uploaded deck reaches the rail, ahead of the built-in catalog.
  expect(
    queryAllByRoleFast("button", templates).filter((item) => {
      return item.textContent?.trim().startsWith("My brand deck");
    }),
  ).toHaveLength(4);
  click(button("My brand deck", templates));
  await waitFor(() => {
    expect(editor).toHaveTextContent("My brand deck");
  });
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(capture.selectedTemplates).toHaveLength(1);
  });
  expect(capture.selectedTemplates[0]).toMatchObject({
    type: "presentation",
    selection: { templateId: `user-template:${deck.id}` },
  });
});

test("Importing a deck uses the existing analysis flow without a create-mode instruction", async () => {
  const capture = mockTemplateChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000023",
    filename: "brand.pdf",
    contentType: "application/pdf",
    size: 5,
    url: "https://cdn.example.test/brand.pdf",
  });
  const user = userEvent.setup({ delay: null });
  await setupChips();
  click(
    button(
      "Presentation",
      screen.getByRole("group", { name: "Choose a task" }),
    ),
  );
  const input = await screen.findByLabelText("Import your own deck");
  await user.upload(
    input,
    new File(["brand"], "brand.pdf", { type: "application/pdf" }),
  );
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual([
    "Analyse this deck and save its visual language as a reusable presentation template.",
  ]);
  expect(capture.sentMessages[0]?.parts).toContainEqual(
    expect.objectContaining({ type: "file", filenameSnapshot: "brand.pdf" }),
  );
});

test("Browsing the catalog opens the existing library in the matching category", async () => {
  mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Keep my draft");
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  click(button("Presentation", tasks));
  click(button("More templates"));
  const dialog = await screen.findByRole("dialog");
  expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
  click(button("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(editor).toHaveTextContent("Keep my draft");
});

test.each([
  {
    task: "Website",
    shelf: "Website templates",
    browse: "Browse all templates",
  },
  { task: "Image", shelf: "Image styles", browse: "Browse all styles" },
])(
  "$task shows a cover shelf carrying its whole catalog and attaches a template",
  async ({ task, shelf, browse }) => {
    mockTemplateChat();
    const editor = await setupChips();
    await fill(editor, "Keep my draft");
    click(button(task, screen.getByRole("group", { name: "Choose a task" })));
    const covers = templateShelf(shelf);
    expect(button(browse, covers)).toBeVisible();
    // The rail carries every cover rather than one page of them, so reaching
    // the rest is scrolling rather than a re-render.
    expect(coverButtons(covers).length).toBeGreaterThan(5);
    click(coverButtons(covers)[0]!);
    await waitFor(() => {
      expect(composerInlineTemplates()).toHaveLength(1);
    });
    expect(editor).toHaveTextContent("Keep my draft");
  },
);

test("Task chips do not replace the composer in an existing conversation", async () => {
  mockTemplateChat();
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerTaskChips]: true },
  });
  await findComposerEditor();
  expect(
    screen.queryByRole("region", { name: "Tasks to get started" }),
  ).toBeNull();
});

function workflowTiles(container: ParentNode): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((item) => {
    return item.dataset.slot === "workflow-recommendation-tile";
  });
}

async function selectWorkflow(): Promise<HTMLElement> {
  const editor = await setupChips();
  click(
    button("Workflow", screen.getByRole("group", { name: "Choose a task" })),
  );
  await screen.findByRole("group", { name: "Workflows" });
  return editor;
}

// The Workflow tab is a shelf like every other type's: one titled rail that
// carries all nine covers, each captioned by its title and nothing else, so
// there is no page to turn and nothing on the shelf edits the draft.
test("The Workflow shelf carries every recommendation on one rail without changing the draft", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  await fill(editor, "Keep this context");
  const shelf = screen.getByRole("group", { name: "Workflows" });
  const tiles = workflowTiles(shelf);
  expect(tiles).toHaveLength(9);
  expect(
    tiles.map((tile) => {
      return tile.textContent;
    }),
  ).toStrictEqual([
    "Start your day with a clear plan",
    "Walk into meetings prepared",
    "Keep important emails moving",
    "Wrap up your week clearly",
    "Turn meetings into next steps",
    "Keep your invoices organized",
    "Know when competitors change",
    "See how your business is doing",
    "Catch the reply you’re waiting for",
  ]);
  expect(editor).toHaveTextContent("Keep this context");
  expect(capture.sentMessages).toHaveLength(0);
});

test("Browse workflows opens the existing template picker in Workflow and preserves the draft", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  await fill(editor, "Keep my draft");
  click(button("Browse workflows"));
  const dialog = await screen.findByRole("dialog");
  expect(tabByText("Workflow")).toHaveAttribute("aria-selected", "true");
  expect(
    button("Select workflow template Morning brief", dialog),
  ).toBeVisible();
  click(button("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(editor.textContent).toBe("Keep my draft");
  expect(capture.sentMessages).toHaveLength(0);
});

test("Each built-in workflow opens its result preview", async () => {
  mockTemplateChat();
  await selectWorkflow();
  for (const title of [
    "Start your day with a clear plan",
    "Walk into meetings prepared",
    "Keep important emails moving",
    "Wrap up your week clearly",
    "Turn meetings into next steps",
    "Keep your invoices organized",
    "Know when competitors change",
    "See how your business is doing",
    "Catch the reply you’re waiting for",
  ]) {
    click(button(title));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img", { name: /^Sample:/ })).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: title })).toBeVisible();
    click(button("Close", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  }
});

test("Choosing a built-in workflow preserves the draft and preferences until the user sends", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  await fill(editor, "Keep my draft");
  click(button("Start your day with a clear plan"));
  const dialog = await screen.findByRole("dialog", { name: "Morning brief" });
  await fill(
    within(dialog).getByLabelText("Anything you’d like to tailor?"),
    "Focus on customer meetings",
  );
  expect(editor).toHaveTextContent("Keep my draft");
  click(button("Use this workflow", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(editor).toHaveTextContent("Keep my draft");
  expect(editor).toHaveTextContent("Help me set up a morning brief");
  expect(editor).toHaveTextContent(
    "What matters to me: Focus on customer meetings",
  );
  expect(capture.sentMessages).toHaveLength(0);
  await waitFor(() => {
    expect(editor).toHaveFocus();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(capture.selectedTemplates).toHaveLength(1);
  });
  expect(capture.selectedTemplates[0]).toMatchObject({
    type: "workflow",
    selection: { workflowTemplateId: "workflow-template:morning-brief" },
  });
});

/**
 * The add menu's row and the Workflow chip start the same job, so the row
 * leaves the composer where the chip would: the prompt in the draft and the
 * workflow ideas open, rather than a written prompt the member still has to
 * pair with a chip.
 */
test("Create workflow writes its prompt and opens the workflow task", async () => {
  mockTemplateChat();
  const editor = await setupChipsWithAddMenu(true);
  click(await addMenuRow(editor, "Create workflow"));

  await waitFor(() => {
    expect(editor).toHaveTextContent(CREATE_WORKFLOW_PROMPT);
  });
  expect(selectedTask(editor, "Workflow")).toBeVisible();
  await expect(
    screen.findByRole("group", { name: "Workflows" }),
  ).resolves.toBeVisible();
});

// With the chips off there is no task to open, and the row is still the prompt.
test("Create workflow selects no task while the chips are off", async () => {
  mockTemplateChat();
  const editor = await setupChipsWithAddMenu(false);
  click(await addMenuRow(editor, "Create workflow"));

  await waitFor(() => {
    expect(editor).toHaveTextContent(CREATE_WORKFLOW_PROMPT);
  });
  expect(
    queryAllByRoleFast("button", composerCard(editor)).some((item) => {
      return item.getAttribute("aria-label") === "Remove Workflow";
    }),
  ).toBeFalsy();
});

test("Reply tracking prepares a custom workflow request without an unrelated template", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  click(button("Catch the reply you’re waiting for"));
  const dialog = await screen.findByRole("dialog");
  click(button("Use this workflow", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(editor).toHaveTextContent("Help me watch one Gmail conversation");
  expect(editor).toHaveTextContent("reply");
  expect(capture.sentMessages).toHaveLength(0);
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.selectedTemplates).toHaveLength(0);
});
