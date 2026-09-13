import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { findComposerEditor, tabByText } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  context,
  createUploadedTemplate,
  mockPresentationTemplateLibrary,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

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
      [FeatureSwitchKey.ComposerCreateCommands]: false,
    },
  });
  return await findComposerEditor();
}

function selectedTask(editor: HTMLElement, task: string): HTMLElement {
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected composer card");
  }
  return within(card).getByRole("group", { name: task });
}

function ideaButtons(ideas: HTMLElement): HTMLElement[] {
  return queryAllByRoleFast("button", ideas).filter((item) => {
    return !["More ideas", "More templates"].includes(
      item.textContent?.trim() ?? "",
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
    "Video",
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

test.each([
  "Workflow",
  "Presentation",
  "Image",
  "Video",
  "Website",
  "Visualization",
])(
  "%s moves into the composer and can be removed without losing the draft",
  async (task) => {
    mockTemplateChat();
    const editor = await setupChips();
    await fill(editor, "Keep my draft");
    click(button(task, screen.getByRole("group", { name: "Choose a task" })));
    const selected = selectedTask(editor, task);
    expect(selected).toBeVisible();
    expect(screen.queryByRole("group", { name: "Choose a task" })).toBeNull();
    expect(editor).toHaveFocus();
    expect(editor).toHaveTextContent("Keep my draft");
    if (task === "Presentation") {
      await screen.findByRole("group", { name: "Presentation templates" });
    } else if (task === "Visualization") {
      await screen.findByRole("region", { name: "Visualization options" });
    } else {
      await screen.findByRole("group", { name: "Ideas to get started" });
    }
    click(button(`Remove ${task}`, selected));
    await screen.findByRole("group", { name: "Choose a task" });
    expect(screen.queryByRole("group", { name: task })).toBeNull();
    expect(
      screen.queryByRole("group", { name: "Ideas to get started" }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", { name: "Presentation templates" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Visualization options" }),
    ).toBeNull();
    expect(editor).toHaveTextContent("Keep my draft");
    expect(editor).toHaveFocus();
  },
);

test.each([
  "Workflow",
  "Presentation",
  "Image",
  "Video",
  "Website",
  "Visualization",
])("Backspace removes %s from an empty composer", async (task) => {
  mockTemplateChat();
  const user = userEvent.setup({ delay: null });
  const editor = await setupChips();
  click(button(task, screen.getByRole("group", { name: "Choose a task" })));
  expect(selectedTask(editor, task)).toBeVisible();
  await user.keyboard("{Backspace}");
  await screen.findByRole("group", { name: "Choose a task" });
  expect(screen.queryByRole("group", { name: task })).toBeNull();
  expect(editor).toHaveFocus();
});

test("Backspace edits a nonempty draft and preserves task selection during composition", async () => {
  mockTemplateChat();
  const user = userEvent.setup({ delay: null });
  const editor = await setupChips();
  click(
    button("Workflow", screen.getByRole("group", { name: "Choose a task" })),
  );
  await fill(editor, "Keep");
  await user.keyboard("{Backspace}");
  expect(editor).toHaveTextContent("Kee");
  expect(selectedTask(editor, "Workflow")).toBeVisible();
  await fill(editor, "");
  fireEvent.keyDown(editor, {
    key: "Backspace",
    isComposing: true,
    keyCode: 229,
  });
  expect(selectedTask(editor, "Workflow")).toBeVisible();
});

test("The original start cards remain when task chips are disabled", async () => {
  mockTemplateChat();
  await setupChips(false);
  expect(screen.getByTestId("start-cards")).toBeInTheDocument();
  expect(
    document.querySelector('[data-slot="workflow-recommendation-card"]'),
  ).toBeNull();
  expect(screen.queryByText("Browse workflows")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Tasks to get started" }),
  ).toBeNull();
});

test("Visualization starts with no selected preferences", async () => {
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
  const outputOptions = queryAllByRoleFast("button", outputPicker);
  expect(outputOptions).toHaveLength(4);
  for (const output of outputOptions) {
    expect(output).toHaveAttribute("aria-pressed", "false");
  }
  const chartPicker = within(panel).getByRole("group", {
    name: "Preferred charts",
  });
  const chartOptions = queryAllByRoleFast("button", chartPicker).filter(
    (chart) => {
      return chart.hasAttribute("aria-pressed");
    },
  );
  expect(chartOptions).toHaveLength(18);
  for (const chart of chartOptions) {
    expect(chart).toHaveAttribute("aria-pressed", "false");
  }
  expect(within(panel).queryByText("Visual methods")).toBeNull();

  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  const additionalInfo = capture.sentMessages[0]?.parts.find((part) => {
    return part.type === "additional_info";
  });
  expect(additionalInfo).toMatchObject({
    type: "additional_info",
    text: expect.stringContaining(
      "The user wants a visualized result for this run.",
    ),
  });
  expect(additionalInfo).toMatchObject({
    text: expect.not.stringContaining("Preferred output format"),
  });
  expect(additionalInfo).toMatchObject({
    text: expect.not.stringContaining("Preferred chart types"),
  });
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

test("Visualization preferences stay behind once another task is chosen", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Explain the quarterly results");
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  click(button("Visualization", tasks));
  const panel = await screen.findByRole("region", {
    name: "Visualization options",
  });
  click(
    button(
      "Report",
      within(panel).getByRole("group", { name: "Output format" }),
    ),
  );
  click(
    button(
      "Bar chart",
      within(panel).getByRole("group", { name: "Preferred charts" }),
    ),
  );

  click(button("Remove Visualization", selectedTask(editor, "Visualization")));
  click(
    button(
      "Website",
      await screen.findByRole("group", { name: "Choose a task" }),
    ),
  );
  await screen.findByRole("group", { name: "Ideas to get started" });

  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  const parts = capture.sentMessages[0]?.parts ?? [];
  expect(
    parts.filter((part) => {
      return (
        part.type === "additional_info" && part.text.includes("# Visualization")
      );
    }),
  ).toStrictEqual([]);
});

test.each([
  { task: "Image", mode: "image", instruction: "Create an image." },
  { task: "Video", mode: "video", instruction: "Create a video." },
  {
    task: "Presentation",
    mode: "presentation",
    instruction: "Create a presentation.",
  },
])(
  "$task enters and submits the existing create mode with only the chip switch enabled",
  async ({ task, instruction }) => {
    const capture = mockTemplateChat();
    const editor = await setupChips();
    const tasks = screen.getByRole("group", { name: "Choose a task" });
    await fill(editor, "My launch next week");
    click(button(task, tasks));
    await waitFor(() => {
      expect(selectedTask(editor, task)).toBeVisible();
    });
    expect(screen.queryByRole("group", { name: "Choose a task" })).toBeNull();
    expect(editor).toHaveTextContent("My launch next week");
    expect(capture.sentMessages).toHaveLength(0);
    click(button("Send"));
    await waitFor(() => {
      expect(capture.runPrompts).toHaveLength(1);
    });
    expect(capture.runPrompts).toStrictEqual(["My launch next week"]);
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining(instruction),
    });
    await expect(
      screen.findByText("My launch next week"),
    ).resolves.toBeVisible();
  },
);

test("Task changes preserve uploaded files and the draft, and toggling off restores ordinary chat", async () => {
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
  click(button("Remove Image", selectedTask(editor, "Image")));
  const restoredTasks = await screen.findByRole("group", {
    name: "Choose a task",
  });
  click(button("Video", restoredTasks));
  await screen.findByRole("combobox", { name: "Video models" });
  click(screen.getByRole("combobox", { name: "Ratio" }));
  click(await screen.findByRole("option", { name: "9:16" }));
  click(button("Remove Video", selectedTask(editor, "Video")));
  await screen.findByRole("combobox", { name: "Claude Sonnet 4.6" });
  expect(screen.queryByTestId("composer-create-mode")).toBeNull();
  expect(editor).toHaveTextContent("Keep my draft");
  expect(screen.getByText("brief.txt")).toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
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
    next: "Make a cover for my newsletter",
    prompt: "Put my product in a new scene.",
    cycle: [
      "Make a cover for my newsletter",
      "Design a birthday invitation",
      "Create an image for my website",
      "Make a personal greeting card",
      "Put my product in a new scene",
    ],
  },
  {
    task: "Video",
    first: "Turn a photo into a video",
    next: "Explain an idea visually",
    prompt: "Animate a photo I provide",
    cycle: ["Explain an idea visually", "Turn a photo into a video"],
  },
  {
    task: "Website",
    first: "Build a website for my business",
    next: "Put my café menu online",
    prompt: "Build a website that explains my business",
    cycle: ["Put my café menu online", "Build a website for my business"],
  },
])(
  "$task ideas rotate without changing the draft and append without replacing it",
  async ({ task, first, next, prompt, cycle }) => {
    const capture = mockTemplateChat();
    const editor = await setupChips();
    const tasks = screen.getByRole("group", { name: "Choose a task" });
    click(button(task, tasks));
    const ideas = await screen.findByRole("group", {
      name: "Ideas to get started",
    });
    expect(ideaButtons(ideas)).toHaveLength(4);
    await fill(editor, "Keep this context");
    click(button(first, ideas));
    await waitFor(() => {
      expect(editor).toHaveTextContent(prompt);
    });
    const draft = editor.textContent;
    click(button(first, ideas));
    expect(editor.textContent).toBe(draft);
    click(button("More ideas", ideas));
    await within(ideas).findByText(next);
    expect(within(ideas).queryByText(first)).toBeNull();
    expect(editor.textContent).toBe(draft);
    for (const label of cycle.slice(1)) {
      click(button("More ideas", ideas));
      await within(ideas).findByText(label);
      expect(ideaButtons(ideas)).toHaveLength(4);
      expect(editor.textContent).toBe(draft);
    }
    expect(editor).toHaveTextContent("Keep this context");
    expect(capture.sentMessages).toHaveLength(0);
  },
);

test("Slash commands keep the selected task and recommendations in sync", async () => {
  mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "A quiet garden /create image");
  const menu = await screen.findByTestId("slash-workflow-menu");
  click(button("Create image", menu));
  await waitFor(() => {
    expect(selectedTask(editor, "Image")).toBeVisible();
  });
  expect(screen.queryByRole("group", { name: "Choose a task" })).toBeNull();
  expect(editor).toHaveTextContent("A quiet garden");
  expect(editor).not.toHaveTextContent("/create image");
  await fill(editor, "A quiet garden /create video");
  const videoMenu = await screen.findByTestId("slash-workflow-menu");
  click(button("Create video", videoMenu));
  await waitFor(() => {
    expect(selectedTask(editor, "Video")).toBeVisible();
  });
  expect(screen.queryByRole("group", { name: "Image" })).toBeNull();
  await screen.findByText("Turn a photo into a video");
  expect(editor).toHaveTextContent("A quiet garden");
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
  for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS.slice(0, 3)) {
    expect(button(item.title, templates)).toBeInTheDocument();
  }
  expect(
    queryAllByRoleFast("button", templates).some((item) => {
      return (
        item.textContent?.trim() ===
        PRESENTATION_TEMPLATE_PICKER_ITEMS[3]!.title
      );
    }),
  ).toBeFalsy();
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
  expect(
    queryAllByRoleFast("button", templates).filter((item) => {
      return item.textContent?.trim().startsWith("My brand deck");
    }),
  ).toHaveLength(3);
  click(button("My brand deck", templates));
  await waitFor(() => {
    expect(editor).toHaveTextContent("My brand deck");
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

test("More templates and Website open the existing library in the matching category", async () => {
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
  click(button("Remove Presentation", selectedTask(editor, "Presentation")));
  const restoredTasks = await screen.findByRole("group", {
    name: "Choose a task",
  });
  click(button("Website", restoredTasks));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(selectedTask(editor, "Website")).toBeVisible();
  expect(screen.queryByRole("group", { name: "Choose a task" })).toBeNull();
  await screen.findByText("Build a website for my business");
  click(button("More templates"));
  await screen.findByRole("dialog");
  expect(tabByText("Website")).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByTestId("composer-create-mode")).toBeNull();
  expect(editor).toHaveTextContent("Keep my draft");
});

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

test("Starting ideas use the active app language", async () => {
  mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    locale: "ja-JP",
    featureSwitches: { [FeatureSwitchKey.ComposerTaskChips]: true },
  });
  const editor = await findComposerEditor();
  click(
    button("ワークフロー", screen.getByRole("group", { name: "タスクを選ぶ" })),
  );
  click(button("明確な計画で一日を始める"));
  const dialog = await screen.findByRole("dialog", {
    name: "モーニングブリーフ",
  });
  click(button("このワークフローを使う", dialog));
  await waitFor(() => {
    expect(editor).toHaveTextContent("重要なメールと今日の予定を読む");
  });
});

function workflowCards(container: ParentNode): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((item) => {
    return item.dataset.slot === "workflow-recommendation-card";
  });
}

async function selectWorkflow(): Promise<HTMLElement> {
  const editor = await setupChips();
  click(
    button("Workflow", screen.getByRole("group", { name: "Choose a task" })),
  );
  await screen.findByRole("group", { name: "Ideas to get started" });
  return editor;
}

test("Workflow result cards rotate three at a time without changing the draft", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  await fill(editor, "Keep this context");
  const ideas = screen.getByRole("group", { name: "Ideas to get started" });
  const pages = [
    "Start your day with a clear plan",
    "Wrap up your week clearly",
    "Know when competitors change",
    "Start your day with a clear plan",
  ];
  for (const [index, title] of pages.entries()) {
    if (index > 0) {
      click(button("More ideas", ideas));
    }
    expect(workflowCards(ideas)).toHaveLength(3);
    expect(button(title, ideas)).toBeVisible();
    expect(editor).toHaveTextContent("Keep this context");
  }
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
  click(tabByText("Website"));
  click(button("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(button("Browse workflows"));
  await screen.findByRole("dialog");
  expect(tabByText("Workflow")).toHaveAttribute("aria-selected", "true");
  expect(editor.textContent).toBe("Keep my draft");
  expect(capture.sentMessages).toHaveLength(0);
});

test.each([
  ["Start your day with a clear plan", 0],
  ["Walk into meetings prepared", 0],
  ["Keep important emails moving", 0],
  ["Wrap up your week clearly", 1],
  ["Turn meetings into next steps", 1],
  ["Keep your invoices organized", 1],
  ["Know when competitors change", 2],
  ["See how your business is doing", 2],
  ["Catch the reply you’re waiting for", 2],
] as const)("%s opens its result preview", async (title, page) => {
  mockTemplateChat();
  await selectWorkflow();
  for (let index = 0; index < page; index++) {
    click(button("More ideas"));
  }
  click(button(title));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("img", { name: /^Sample:/ })).toBeVisible();
  expect(within(dialog).getByRole("heading", { name: title })).toBeVisible();
});

test("Browse workflows from a result preview opens the existing picker without overlapping dialogs", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  await fill(editor, "Keep my draft");
  click(button("Start your day with a clear plan"));
  const preview = await screen.findByRole("dialog", { name: "Morning brief" });
  click(button("Browse workflows", preview));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Morning brief" })).toBeNull();
  });
  const picker = screen.getByRole("dialog");
  expect(tabByText("Workflow")).toHaveAttribute("aria-selected", "true");
  expect(
    button("Select workflow template Morning brief", picker),
  ).toBeVisible();
  click(button("Close", picker));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(editor.textContent).toBe("Keep my draft");
  expect(capture.sentMessages).toHaveLength(0);
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

test("Closing or navigating a workflow preview does not edit or send the draft", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  await fill(editor, "My existing draft");
  click(button("Start your day with a clear plan"));
  let dialog = await screen.findByRole("dialog", { name: "Morning brief" });
  await fill(
    within(dialog).getByLabelText("Anything you’d like to tailor?"),
    "Do not copy to another workflow",
  );
  click(button("Next workflow", dialog));
  dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByLabelText("Anything you’d like to tailor?"),
  ).toHaveValue("");
  expect(
    within(dialog).getByRole("heading", {
      name: "Walk into meetings prepared",
    }),
  ).toBeVisible();
  click(button("Previous workflow", dialog));
  dialog = await screen.findByRole("dialog", { name: "Morning brief" });
  click(button("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(editor.textContent).toBe("My existing draft");
  expect(capture.sentMessages).toHaveLength(0);
});

test("Reply tracking prepares a custom workflow request without an unrelated template", async () => {
  const capture = mockTemplateChat();
  const editor = await selectWorkflow();
  click(button("More ideas"));
  click(button("More ideas"));
  click(button("Catch the reply you’re waiting for"));
  const dialog = await screen.findByRole("dialog");
  click(button("Use this workflow", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(editor).toHaveTextContent("Help me watch one Gmail conversation");
  expect(editor).toHaveTextContent("reply");
  expect(capture.sentMessages).toHaveLength(0);
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.selectedTemplates).toHaveLength(0);
});
