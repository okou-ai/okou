import { mockRailBrowserLayout, renderedRail } from "./rail-browser-layout.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
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
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

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

async function setupChips(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  return await findComposerEditor();
}

async function selectCreation(task: string): Promise<void> {
  const cards = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  const create = within(cards).getByRole("region", { name: "Create" });
  click(button("Presentation", create));
  const types = await screen.findByRole("radiogroup", { name: "Create" });
  const choice = queryAllByRoleFast("radio", types).find((item) => {
    return item.textContent?.trim() === task;
  });
  if (!choice) {
    throw new Error(`Expected creation type ${task}`);
  }
  click(choice);
  await waitFor(() => {
    expect(choice).toHaveAttribute("aria-checked", "true");
  });
}

function composerCard(editor: HTMLElement): HTMLElement {
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected composer card");
  }
  return card;
}

function selectedTask(editor: HTMLElement, task: string): HTMLElement {
  return button(`Remove ${task}`, composerCard(editor));
}

function coverButtons(shelf: HTMLElement): HTMLElement[] {
  return queryAllByRoleFast("button", shelf).filter((item) => {
    return (
      item.getAttribute("aria-label")?.startsWith("Use template ") === true
    );
  });
}

test("A creation type can be removed without losing the draft", async () => {
  mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Keep my draft");
  await selectCreation("Presentation");
  const selected = selectedTask(editor, "Presentation");
  expect(selected).toBeInTheDocument();
  expect(editor).toHaveTextContent("Keep my draft");
  await screen.findByRole("group", { name: "Presentation templates" });
  click(selected);
  await screen.findByRole("group", { name: "Explore Okou capabilities" });
  expect(editor).toHaveTextContent("Keep my draft");
});

test("A send carries the task and its slide count into the thread it opens", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  await selectCreation("Presentation");
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
  const threadEditor = await findComposerEditor();
  expect(selectedTask(threadEditor, "Presentation")).toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Slide count" }),
  ).toHaveTextContent("16–20 slides");
});

test("Chart preferences are interactive and are sent as agent-only context", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Explain the quarterly results");
  await selectCreation("Chart");
  const panel = await screen.findByRole("region", {
    name: "Visualization options",
  });
  expect(selectedTask(editor, "Chart")).toHaveTextContent("Chart");
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

test("Chart defaults to report when no output format is selected", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Summarize the quarterly results in a chart");
  await selectCreation("Chart");
  await screen.findByRole("region", { name: "Visualization options" });
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  const additionalInfo = capture.sentMessages[0]?.parts.find((part) => {
    return part.type === "additional_info";
  });
  expect(additionalInfo).toMatchObject({
    type: "additional_info",
    text: expect.stringContaining("- Preferred output format: report"),
  });
});

test("Image enters and submits the create mode", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "My launch next week");
  await selectCreation("Image");
  expect(selectedTask(editor, "Image")).toBeInTheDocument();
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
  await selectCreation("Image");
  click(selectedTask(editor, "Image"));
  await screen.findByRole("group", { name: "Explore Okou capabilities" });
  await selectCreation("Presentation");
  const slideCount = await screen.findByRole("combobox", {
    name: "Slide count",
  });
  click(slideCount);
  click(await screen.findByRole("option", { name: "16–20 slides" }));
  await waitFor(() => {
    expect(slideCount).toHaveTextContent("16–20 slides");
  });
  click(selectedTask(editor, "Presentation"));
  await composerModelTrigger("Auto");
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
  expect(capture.sentMessages[0]?.parts).not.toContainEqual(
    expect.objectContaining({ type: "additional_info" }),
  );
});

test.each([
  {
    entry: "Presentation",
    category: "Image",
    task: "Image",
    template: ILLUSTRATION_TEMPLATE_ITEMS[0]!,
    type: "illustration",
    instructions: ["Create an image."],
  },
  {
    entry: "Image",
    category: "Presentation",
    task: "Presentation",
    template: PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!,
    type: "presentation",
    instructions: [expect.stringContaining("Create a presentation.")],
  },
  {
    entry: "Presentation",
    category: "Website",
    task: "Website",
    template: WEBSITE_TEMPLATE_ITEMS[0]!,
    type: "website",
    instructions: [],
  },
])(
  "Selecting $category from the $entry catalog updates the task and generation settings",
  async ({ entry, category, task, template, type, instructions }) => {
    const capture = mockTemplateChat();
    context.mocks.data.userPreferences({ timezone: "UTC", locale: "en-US" });
    const editor = await setupChips();
    await fill(editor, "Keep my launch brief");
    await selectCreation(entry);
    click(button("View all", screen.getByRole("tabpanel")));
    const dialog = await screen.findByRole("dialog");
    click(tabByText(category));
    click(
      await within(dialog).findByLabelText(
        `Select ${type === "website" ? "website " : ""}template ${template.title}`,
      ),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(selectedTask(editor, task)).toBeInTheDocument();
    expect(editor).toHaveTextContent("Keep my launch brief");
    expect(composerInlineTemplates()).toHaveLength(1);
    expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
    expect(
      screen.queryAllByRole("combobox", { name: "Slide count" }),
    ).toHaveLength(type === "presentation" ? 1 : 0);

    click(button("Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(capture.selectedTemplates).toHaveLength(1);
    expect(capture.selectedTemplates[0]).toMatchObject({ type });
    expect(
      capture.sentMessages[0]?.parts.flatMap((part) => {
        return part.type === "additional_info" ? [part.text] : [];
      }),
    ).toStrictEqual(instructions);
  },
);

test("A presentation suggestion inserts a canonical template and preserves the prompt", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Explain our product launch");
  await selectCreation("Presentation");
  const templates = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  expect(
    within(templates).getByLabelText("Import your own deck"),
  ).toHaveAttribute("accept", ".pptx,.ppt,.pdf");
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

test("Browsing the catalog opens the existing library in the matching category", async () => {
  mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Keep my draft");
  await selectCreation("Presentation");
  click(button("View all", screen.getByRole("tabpanel")));
  const dialog = await screen.findByRole("dialog");
  expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
  click(button("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(editor).toHaveTextContent("Keep my draft");
});

test.each([
  { task: "Website", shelf: "Website templates" },
  { task: "Image", shelf: "Image styles" },
])(
  "$task shows its whole catalog and attaches a template",
  async ({ task, shelf }) => {
    mockTemplateChat();
    const editor = await setupChips();
    await fill(editor, "Keep my draft");
    await selectCreation(task);
    const covers = await screen.findByRole("group", { name: shelf });
    expect(
      button("View all", screen.getByRole("tabpanel")),
    ).toBeInTheDocument();
    expect(coverButtons(covers).length).toBeGreaterThan(5);
    click(coverButtons(covers)[0]!);
    await waitFor(() => {
      expect(composerInlineTemplates()).toHaveLength(1);
    });
    expect(editor).toHaveTextContent("Keep my draft");
  },
);

test("The Document catalog pages using its current viewport width", async () => {
  const layout = mockRailBrowserLayout({
    viewportWidth: 400,
    contentWidth: 1600,
  });
  mockTemplateChat();
  await setupChips();
  await selectCreation("Document");
  const shelf = await screen.findByRole("group", {
    name: "Document templates",
  });
  const firstTemplate = await waitFor(() => {
    return button("Use template Content brief", shelf);
  });
  const rail = renderedRail(firstTemplate);
  layout.setViewportWidth(rail.viewport, 460);

  click(button("Next page", rail.root));
  expect(rail.viewport.scrollLeft).toBe(396);

  layout.setViewportWidth(rail.viewport, 300);
  fireEvent(window, new Event("resize"));
  click(button("Next page", rail.root));
  expect(rail.viewport.scrollLeft).toBe(632);

  click(button("Previous page", rail.root));
  expect(rail.viewport.scrollLeft).toBe(396);
});

function workflowTiles(container: ParentNode): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((item) => {
    return item.dataset.slot === "workflow-recommendation-tile";
  });
}

async function selectWorkflow(): Promise<HTMLElement> {
  const editor = await setupChips();
  const cards = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  click(button("Advanced workflows", cards));
  await screen.findByRole("region", { name: "Advanced workflows" });
  return editor;
}

test("Advanced workflows carries every recommendation without changing the draft", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  await fill(editor, "Keep this context");
  const shelf = screen.getByRole("region", { name: "Advanced workflows" });
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

test("Workflow covers draw their marks without waiting for the full connector catalog", async () => {
  mockTemplateChat();
  const fullCatalog = context.mocks.deferred<void>();
  context.mocks.api(
    connectorCatalogContract.status,
    async ({ respond, withSignal }) => {
      await withSignal(fullCatalog.promise);
      return respond(200, { connectors: [] });
    },
  );
  await selectWorkflow();
  const [morning] = workflowTiles(
    screen.getByRole("region", { name: "Advanced workflows" }),
  );
  await waitFor(() => {
    expect(morning?.querySelectorAll("img")).toHaveLength(3);
  });
});

test("View all opens the Workflow template picker and preserves the draft", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  await fill(editor, "Keep my draft");
  click(button("View all", screen.getByRole("tabpanel")));
  const dialog = await screen.findByRole("dialog");
  expect(tabByText("Workflow")).toHaveAttribute("aria-selected", "true");
  expect(
    button("Select workflow template Morning brief", dialog),
  ).toBeInTheDocument();
  click(button("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(editor.textContent).toBe("Keep my draft");
  expect(capture.sentMessages).toHaveLength(0);
});

test("Choosing a workflow prepares an editable request until the user sends", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  await fill(editor, "Keep my draft");
  const shelf = screen.getByRole("region", { name: "Advanced workflows" });
  click(button("Start your day with a clear plan", shelf));
  expect(editor).toHaveTextContent("Keep my draft");
  expect(editor).toHaveTextContent("Help me set up a morning brief");
  expect(composerInlineTemplates()[0]).toHaveTextContent("Morning brief");
  expect(editor).toHaveFocus();
  await userEvent.setup({ delay: null }).paste(" Focus on customer meetings.");
  expect(editor).toHaveTextContent("Focus on customer meetings.");
  expect(capture.sentMessages).toHaveLength(0);
  click(button("Send"));
  await waitFor(() => {
    expect(capture.selectedTemplates).toHaveLength(1);
  });
  expect(capture.selectedTemplates[0]).toMatchObject({
    type: "workflow",
    selection: { workflowTemplateId: "workflow-template:morning-brief" },
  });
});

test("Reply tracking prepares a custom workflow request without an unrelated template", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  click(
    button(
      "Catch the reply you’re waiting for",
      screen.getByRole("region", { name: "Advanced workflows" }),
    ),
  );
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
