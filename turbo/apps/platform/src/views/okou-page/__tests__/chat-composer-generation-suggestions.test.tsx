import {
  chatEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { DOCUMENT_TEMPLATE_ITEMS } from "@okouai/core/document-template-items";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import {
  composerInlineTemplates,
  findComposerEditor,
  selectTemplate,
} from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

function queryButton(
  label: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((item) => {
      return (
        (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label
      );
    }) ?? null
  );
}

function button(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const result = queryButton(label, container);
  if (!result) {
    throw new Error(`Expected button ${label}`);
  }
  return result;
}

function querySuggestions(): HTMLElement | null {
  return screen.queryByRole("region", { name: "Generation suggestions" });
}

async function suggestions(): Promise<HTMLElement> {
  return await screen.findByRole("region", {
    name: "Generation suggestions",
  });
}

function composerCard(editor: HTMLElement): HTMLElement {
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected the composer card");
  }
  return card;
}

function messageText(
  message: UserMessageDocument | undefined,
): string | undefined {
  return message?.parts
    .flatMap((part) => {
      return part.type === "text" ? [part.text] : [];
    })
    .join("")
    .trim();
}

async function setupComposer(options?: {
  readonly path?: string;
  readonly enableSuggestions?: boolean;
}) {
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: options?.path ?? `/agents/${AGENT_ID}/chat`,
    featureSwitches:
      options?.enableSuggestions === false
        ? {}
        : { [FeatureSwitchKey.ComposerGenerationSuggestions]: true },
  });
  const editor = await findComposerEditor();
  return { capture, editor };
}

async function chooseOption(
  panel: HTMLElement,
  label: "Slide count" | "Image aspect ratio",
  name: string,
): Promise<void> {
  const select = within(panel).getByRole("combobox", { name: label });
  click(select);
  click(await screen.findByRole("option", { name }));
  await waitFor(() => {
    expect(select).toHaveTextContent(name);
  });
}

async function applySettings(
  panel: HTMLElement,
  task: "Presentation" | "Image" | "Document" | "Website",
): Promise<void> {
  click(button("Apply settings", panel));
  await waitFor(() => {
    expect(button(`Remove ${task}`)).toBeInTheDocument();
  });
  expect(screen.getByText("This message only")).toBeInTheDocument();
  expect(querySuggestions()).not.toBeInTheDocument();
}

test("The default rollout keeps a bare generation prompt as an ordinary draft", async () => {
  const { capture, editor } = await setupComposer({
    enableSuggestions: false,
  });
  await fill(editor, "slide");
  expect(editor.textContent).toBe("slide");
  expect(
    screen.getByRole("group", { name: "Choose a task" }),
  ).toBeInTheDocument();
  expect(querySuggestions()).not.toBeInTheDocument();
  expect(capture.runPrompts).toHaveLength(0);

  click(button("Send"));
  await waitFor(() => {
    expect(capture.runPrompts).toStrictEqual(["slide"]);
  });
});

test.each([
  {
    task: "Presentation",
    drafts: [
      "The agenda is ready; include SLIDES for the team.",
      "Please review ＰＰＴＸ before noon.",
      "把季度数据整理为演示文稿即可",
    ],
  },
  {
    task: "Image",
    drafts: [
      "image of a cat",
      "For the autumn campaign, I need an image of our product.",
      "Do not generate a Docker image.",
      "Inspect `IMAGES` and 图片素材 later.",
    ],
  },
  {
    task: "Document",
    drafts: [
      'The note says "DOCX"; summarize its contents.',
      "Please compare the documents.",
      "把这份文档整理给客户",
    ],
  },
  {
    task: "Website",
    drafts: [
      "The launch handoff lists website.html.",
      "Review WEBSITES before launch.",
      "请更新公司的网站内容",
    ],
  },
] as const)(
  "$task keywords anywhere in the draft offer a single staged category",
  async ({ task, drafts }) => {
    const { capture, editor } = await setupComposer();
    for (const draft of drafts) {
      await fill(editor, draft);
      const panel = await suggestions();
      await expect(
        within(panel).findByRole("heading", { name: task }),
      ).resolves.toBeInTheDocument();
      expect(
        within(panel).queryByRole("group", { name: "Choose a task" }),
      ).not.toBeInTheDocument();
      expect(button("Apply settings", panel)).toBeEnabled();
      expect(queryButton(`Remove ${task}`)).not.toBeInTheDocument();
      expect(editor.textContent).toBe(draft);
      expect(capture.runPrompts).toHaveLength(0);
    }
  },
);

test("Only whole supported keywords offer automatic generation settings", async () => {
  const { capture, editor } = await setupComposer();
  const drafts = [
    "The slider was reimaged; documentation and mywebsite need review.",
    "Create a report, workflow, or visualization about the campaign.",
    "请整理财报、调研报告、工作流与可视化结果",
  ];
  for (const draft of drafts) {
    await fill(editor, "image");
    await suggestions();
    await fill(editor, draft);
    await waitFor(() => {
      expect(querySuggestions()).not.toBeInTheDocument();
    });
    expect(editor.textContent).toBe(draft);
    expect(capture.runPrompts).toHaveLength(0);
  }
});

test("Slide suggestions stage changes until Apply and expire after this message", async () => {
  const { capture, editor } = await setupComposer();
  await fill(editor, "slide");
  const panel = await suggestions();
  expect(panel).toHaveAttribute("data-placement", "below");
  expect(
    within(panel).getByRole("heading", { name: "Presentation" }),
  ).toBeInTheDocument();
  await chooseOption(panel, "Slide count", "20–24 slides");
  expect(queryButton("Remove Presentation")).not.toBeInTheDocument();
  expect(editor.textContent).toBe("slide");
  expect(capture.runPrompts).toHaveLength(0);

  await applySettings(panel, "Presentation");
  const card = composerCard(editor);
  expect(
    within(card).getByRole("combobox", { name: "Slide count" }),
  ).toHaveTextContent("20–24 slides");
  expect(editor.textContent).toBe("slide");
  expect(capture.runPrompts).toHaveLength(0);

  click(button("Change generation settings", card));
  const changes = await suggestions();
  await chooseOption(changes, "Slide count", "4–8 slides");
  expect(
    within(card).getByRole("combobox", { name: "Slide count" }),
  ).toHaveTextContent("20–24 slides");
  click(button("Dismiss suggestions", changes));
  await waitFor(() => {
    expect(querySuggestions()).not.toBeInTheDocument();
  });
  expect(
    within(card).getByRole("combobox", { name: "Slide count" }),
  ).toHaveTextContent("20–24 slides");
  expect(editor.textContent).toBe("slide");
  expect(capture.runPrompts).toHaveLength(0);

  click(button("Send", card));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual(["slide"]);
  expect(messageText(capture.sentMessages[0])).toBe("slide");
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create a presentation."),
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 20-24"),
  });
  await expect(screen.findByText("slide")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(queryButton("Remove Presentation")).not.toBeInTheDocument();
    expect(screen.queryByText("This message only")).not.toBeInTheDocument();
  });
});

test("Image settings and a built-in style travel as metadata without rewriting the draft", async () => {
  const { capture, editor } = await setupComposer();
  const [template] = ILLUSTRATION_TEMPLATE_ITEMS;
  if (!template) {
    throw new Error("Expected an image template");
  }
  await fill(editor, "image");
  const panel = await suggestions();
  expect(
    within(panel).getByRole("heading", { name: "Image" }),
  ).toBeInTheDocument();
  await chooseOption(panel, "Image aspect ratio", "16:9");
  expect(queryButton("Remove Image")).not.toBeInTheDocument();
  expect(capture.runPrompts).toHaveLength(0);
  await applySettings(panel, "Image");
  expect(editor.textContent).toBe("image");
  expect(button("Change generation settings")).toHaveTextContent("16:9");
  expect(capture.runPrompts).toHaveLength(0);

  click(button("Change generation settings"));
  const changes = await suggestions();
  expect(
    within(changes).getByRole("combobox", { name: "Image aspect ratio" }),
  ).toHaveTextContent("16:9");
  click(button(`Use template ${template.title}`, changes));
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  });
  expect(button("Remove Image")).toBeInTheDocument();
  expect(screen.getByText("This message only")).toBeInTheDocument();
  expect(querySuggestions()).not.toBeInTheDocument();
  expect(editor).toHaveTextContent("image");
  expect(capture.runPrompts).toHaveLength(0);

  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(messageText(capture.sentMessages[0])).toBe("image");
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "template",
    titleSnapshot: template.title,
    template: {
      type: "illustration",
      selection: { illustrationStyleId: template.illustrationStyleId },
    },
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create an image."),
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Preferred aspect ratio: 16:9"),
  });
});

test("Adding a recommendation template preserves selected draft text in the sent message", async () => {
  const { capture, editor } = await setupComposer();
  const user = userEvent.setup({ delay: null });
  const [template] = ILLUSTRATION_TEMPLATE_ITEMS;
  if (!template) {
    throw new Error("Expected an image template");
  }
  const draft = "image of a cat";
  await fill(editor, draft);
  await applySettings(await suggestions(), "Image");

  await user.click(editor);
  const text = editor.querySelector("p")?.firstChild;
  const selection = window.getSelection();
  if (!(text instanceof Text) || !selection) {
    throw new Error("Expected selectable draft text");
  }
  const range = document.createRange();
  range.setStart(text, draft.indexOf("cat"));
  range.setEnd(text, draft.length);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  expect(selection.toString()).toBe("cat");

  // Full pointer/focus events preserve the editor selection across panel focus.
  await user.click(button("Change generation settings"));
  const changes = await suggestions();
  await user.click(button(`Use template ${template.title}`, changes));
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  });

  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(messageText(capture.sentMessages[0])).toBe(draft);
  expect(
    capture.sentMessages[0]?.parts.filter((part) => {
      return part.type === "template";
    }),
  ).toStrictEqual([
    {
      type: "template",
      titleSnapshot: template.title,
      template: {
        type: "illustration",
        selection: { illustrationStyleId: template.illustrationStyleId },
      },
    },
  ]);
});

test("Changing a recommendation after undo replaces the restored template in the sent message", async () => {
  const { capture, editor } = await setupComposer();
  const user = userEvent.setup({ delay: null });
  const [templateA, templateB, templateC] = ILLUSTRATION_TEMPLATE_ITEMS;
  if (!templateA || !templateB || !templateC) {
    throw new Error("Expected three image templates");
  }
  const draft = "image of a cat";
  await fill(editor, draft);
  const panel = await suggestions();

  // ProseMirror timestamps transactions with Date.now, not the app clock.
  // Cross its 500 ms history-group boundary without sleeping or faking timers.
  let transactionTime = now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => {
    return transactionTime;
  });
  try {
    await user.click(button(`Use template ${templateA.title}`, panel));
    await waitFor(() => {
      expect(composerInlineTemplates()).toHaveLength(1);
      expect(composerInlineTemplates()[0]).toHaveTextContent(templateA.title);
    });

    transactionTime += 1000;
    await user.click(button("Change generation settings"));
    const changes = await suggestions();
    await user.click(button(`Use template ${templateB.title}`, changes));
    await waitFor(() => {
      expect(composerInlineTemplates()).toHaveLength(1);
      expect(composerInlineTemplates()[0]).toHaveTextContent(templateB.title);
    });

    await user.click(editor);
    await user.keyboard("{Control>}z{/Control}");
    await waitFor(() => {
      expect(composerInlineTemplates()).toHaveLength(1);
      expect(composerInlineTemplates()[0]).toHaveTextContent(templateA.title);
    });

    // A normal collapsed caret must not make insertion replace the restored chip.
    const selection = window.getSelection();
    if (!selection) {
      throw new Error("Expected a composer selection");
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    expect(selection.isCollapsed).toBeTruthy();

    await user.click(button("Change generation settings"));
    const restoredChanges = await suggestions();
    await user.click(
      button(`Use template ${templateC.title}`, restoredChanges),
    );
    await waitFor(() => {
      expect(editor).toHaveTextContent(templateC.title);
    });

    click(button("Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(messageText(capture.sentMessages[0])).toBe(draft);
    expect(
      capture.sentMessages[0]?.parts.filter((part) => {
        return part.type === "template";
      }),
    ).toStrictEqual([
      {
        type: "template",
        titleSnapshot: templateC.title,
        template: {
          type: "illustration",
          selection: { illustrationStyleId: templateC.illustrationStyleId },
        },
      },
    ]);
  } finally {
    clock.mockRestore();
  }
});

test("A rejected thread send retains the applied generation settings for retry", async () => {
  const { editor } = await setupComposer({ path: `/chats/${THREAD_ID}` });
  await fill(editor, "image");
  const panel = await suggestions();
  await chooseOption(panel, "Image aspect ratio", "9:16");
  await applySettings(panel, "Image");
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    return respond(400, {
      error: { code: "BAD_REQUEST", message: "Message was not accepted" },
    });
  });
  click(button("Send"));
  await screen.findByText("Message was not accepted");
  expect(button("Remove Image")).toBeInTheDocument();
  expect(button("Change generation settings")).toHaveTextContent("9:16");
  expect(screen.getByText("This message only")).toBeInTheDocument();
  const retry = mockTemplateChat();
  await fill(await findComposerEditor(), "image");
  click(button("Send"));
  await waitFor(() => {
    expect(retry.sentMessages).toHaveLength(1);
  });
  expect(retry.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Preferred aspect ratio: 9:16"),
  });
});

test("A document keyword in a sentence offers a template without rewriting the message", async () => {
  const { capture, editor } = await setupComposer();
  const [template] = DOCUMENT_TEMPLATE_ITEMS;
  if (!template) {
    throw new Error("Expected a document template");
  }
  const draft = "Summarize this document for our team.";
  await fill(editor, draft);
  const panel = await suggestions();
  expect(
    within(panel).getByRole("heading", { name: "Document" }),
  ).toBeInTheDocument();
  expect(button("Apply settings", panel)).toBeEnabled();
  expect(editor.textContent).toBe(draft);
  expect(capture.runPrompts).toHaveLength(0);

  click(button(`Use template ${template.title}`, panel));
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  });
  expect(button("Remove Document")).toBeInTheDocument();
  expect(screen.getByText("This message only")).toBeInTheDocument();
  expect(querySuggestions()).not.toBeInTheDocument();
  expect(editor).toHaveTextContent(draft);
  expect(capture.runPrompts).toHaveLength(0);

  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(messageText(capture.sentMessages[0])).toBe(draft);
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "template",
    titleSnapshot: template.title,
    template: {
      type: "document",
      selection: { documentTemplateId: template.id },
    },
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: "Create a document.",
  });
});

test("A full-text website suggestion sends its catalog template for this message only", async () => {
  const { capture, editor } = await setupComposer();
  const [template] = WEBSITE_TEMPLATE_ITEMS;
  if (!template) {
    throw new Error("Expected a website template");
  }
  const draft = "For our autumn campaign, we need a website for reservations.";
  await fill(editor, draft);
  const panel = await suggestions();
  expect(
    within(panel).getByRole("heading", { name: "Website" }),
  ).toBeInTheDocument();
  expect(queryButton("Remove Website")).not.toBeInTheDocument();
  expect(editor.textContent).toBe(draft);
  expect(capture.runPrompts).toHaveLength(0);

  click(button(`Use template ${template.title}`, panel));
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  });
  expect(button("Remove Website")).toBeInTheDocument();
  expect(screen.getByText("This message only")).toBeInTheDocument();
  expect(querySuggestions()).not.toBeInTheDocument();
  expect(editor).toHaveTextContent(draft);
  expect(capture.runPrompts).toHaveLength(0);

  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(messageText(capture.sentMessages[0])).toBe(draft);
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "template",
    titleSnapshot: template.title,
    template: {
      type: "website",
      selection: { websiteTemplateId: template.id },
    },
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: "Create a website.",
  });
  await expect(screen.findByText(draft)).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(queryButton("Remove Website")).not.toBeInTheDocument();
    expect(screen.queryByText("This message only")).not.toBeInTheDocument();
    expect(composerInlineTemplates()).toHaveLength(0);
  });
  const nextEditor = await findComposerEditor();
  await fill(nextEditor, "Thanks for the update.");
  expect(nextEditor.textContent).toBe("Thanks for the update.");
  expect(queryButton("Change generation settings")).not.toBeInTheDocument();
  expect(querySuggestions()).not.toBeInTheDocument();
});

test("Candidate choices follow first mention and preserve staged options until confirmation", async () => {
  const { capture, editor } = await setupComposer();
  const draft =
    "A website, an image, and slides for launch; another image and a document.";
  await fill(editor, draft);
  const panel = await suggestions();
  expect(
    within(panel).getByRole("heading", { name: "Website" }),
  ).toBeInTheDocument();
  const choices = within(panel).getByRole("group", {
    name: "Choose a task",
  });
  expect(
    queryAllByRoleFast("button", choices).map((choice) => {
      return choice.textContent?.trim();
    }),
  ).toStrictEqual(["Website", "Image", "Presentation", "Document"]);
  expect(button("Website", choices)).toHaveAttribute("aria-pressed", "true");
  for (const task of ["Image", "Presentation", "Document"]) {
    expect(button(task, choices)).toHaveAttribute("aria-pressed", "false");
  }

  click(button("Image", choices));
  await within(panel).findByRole("heading", { name: "Image" });
  expect(button("Image", choices)).toHaveAttribute("aria-pressed", "true");
  expect(button("Website", choices)).toHaveAttribute("aria-pressed", "false");
  await chooseOption(panel, "Image aspect ratio", "16:9");
  click(button("Presentation", choices));
  await within(panel).findByRole("heading", { name: "Presentation" });
  expect(button("Presentation", choices)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(button("Image", choices)).toHaveAttribute("aria-pressed", "false");
  await chooseOption(panel, "Slide count", "20–24 slides");
  click(button("Image", choices));
  await within(panel).findByRole("heading", { name: "Image" });
  expect(
    within(panel).getByRole("combobox", { name: "Image aspect ratio" }),
  ).toHaveTextContent("16:9");
  for (const task of ["Website", "Image", "Presentation", "Document"]) {
    expect(queryButton(`Remove ${task}`)).not.toBeInTheDocument();
  }
  expect(composerInlineTemplates()).toHaveLength(0);
  expect(editor.textContent).toBe(draft);
  expect(capture.runPrompts).toHaveLength(0);

  await applySettings(panel, "Image");
  expect(button("Change generation settings")).toHaveTextContent("16:9");
  click(button("Change generation settings"));
  const changes = await suggestions();
  expect(
    within(changes).getByRole("heading", { name: "Image" }),
  ).toBeInTheDocument();
  expect(
    within(changes).queryByRole("group", { name: "Choose a task" }),
  ).not.toBeInTheDocument();
  expect(
    within(changes).getByRole("combobox", { name: "Image aspect ratio" }),
  ).toHaveTextContent("16:9");
  click(button("Dismiss suggestions", changes));
  await waitFor(() => {
    expect(querySuggestions()).not.toBeInTheDocument();
  });
  expect(button("Remove Image")).toBeInTheDocument();
  expect(editor.textContent).toBe(draft);

  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(messageText(capture.sentMessages[0])).toBe(draft);
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create an image."),
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Preferred aspect ratio: 16:9"),
  });
});

test("Changing a presentation recommendation replaces its previous template", async () => {
  const { capture, editor } = await setupComposer();
  const [template, nextTemplate] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!template || !nextTemplate) {
    throw new Error("Expected presentation templates");
  }
  const draft = "Use slides and an image for our launch.";
  await fill(editor, draft);
  const panel = await suggestions();
  expect(
    within(panel).getByRole("heading", { name: "Presentation" }),
  ).toBeInTheDocument();
  click(button(`Use template ${template.title}`, panel));
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  });
  click(button("Change generation settings"));
  const changes = await suggestions();
  expect(
    within(changes).getByRole("heading", { name: "Presentation" }),
  ).toBeInTheDocument();
  expect(
    within(changes).queryByRole("group", { name: "Choose a task" }),
  ).not.toBeInTheDocument();
  click(button(`Use template ${nextTemplate.title}`, changes));
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
    expect(composerInlineTemplates()[0]).toHaveTextContent(nextTemplate.title);
  });
  expect(button("Remove Presentation")).toBeInTheDocument();
  expect(editor).toHaveTextContent(draft);
  expect(capture.runPrompts).toHaveLength(0);
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.selectedTemplates).toHaveLength(1);
  expect(capture.selectedTemplates[0]).toMatchObject({
    type: "presentation",
    selection: { templateId: nextTemplate.templateId },
  });
  expect(messageText(capture.sentMessages[0])).toBe(draft);
});

test("A same-type manual template selection takes ownership from a recommendation", async () => {
  const { capture, editor } = await setupComposer();
  const [template] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  await fill(editor, "slide");
  await applySettings(await suggestions(), "Presentation");
  await clickComposerAddMenuItem("Add template");
  click(await screen.findByLabelText(`Select template ${template.title}`));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(queryButton("Change generation settings")).not.toBeInTheDocument();
  expect(screen.queryByText("This message only")).not.toBeInTheDocument();
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  await waitFor(() => {
    expect(button("Remove Presentation")).toBeInTheDocument();
  });
});

test("A manually selected task wins over a different generation intent", async () => {
  const { capture, editor } = await setupComposer();
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  click(button("Image", tasks));
  await waitFor(() => {
    expect(button("Remove Image")).toBeInTheDocument();
  });
  await fill(editor, "slide");
  expect(editor.textContent).toBe("slide");
  expect(button("Remove Image")).toBeInTheDocument();
  expect(querySuggestions()).not.toBeInTheDocument();
  expect(queryButton("Change generation settings")).not.toBeInTheDocument();
  expect(capture.runPrompts).toHaveLength(0);

  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(messageText(capture.sentMessages[0])).toBe("slide");
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create an image."),
  });
});

test("A manually attached template suppresses suggestions even after removing its task", async () => {
  const { capture, editor } = await setupComposer();
  const [template] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  await fill(editor, "slide");
  await suggestions();
  await selectTemplate(template);
  click(button("Remove Presentation"));
  await screen.findByRole("group", { name: "Choose a task" });
  expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  expect(editor).toHaveTextContent("slide");
  expect(querySuggestions()).not.toBeInTheDocument();
  expect(capture.runPrompts).toHaveLength(0);

  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(messageText(capture.sentMessages[0])).toBe("slide");
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "template",
    titleSnapshot: template.title,
    template: expect.objectContaining({
      type: "presentation",
      selection: expect.objectContaining({ templateId: template.templateId }),
    }),
  });
  expect(capture.sentMessages[0]?.parts).not.toContainEqual(
    expect.objectContaining({ type: "additional_info" }),
  );
});

test.each(["Dismiss suggestions", "Escape"] as const)(
  "%s closes every matched category through edits until the draft is cleared",
  async (dismissal) => {
    const { capture, editor } = await setupComposer();
    const user = userEvent.setup({ delay: null });
    const draft = "slides and an image";
    await fill(editor, draft);
    const panel = await suggestions();
    expect(
      within(panel).getByRole("heading", { name: "Presentation" }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("group", { name: "Choose a task" }),
    ).toBeInTheDocument();
    if (dismissal === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      click(button(dismissal, panel));
    }
    await waitFor(() => {
      expect(querySuggestions()).not.toBeInTheDocument();
    });
    expect(editor).toHaveFocus();
    expect(editor.textContent).toBe(draft);
    expect(capture.runPrompts).toHaveLength(0);

    await user.keyboard(" for the launch");
    expect(editor.textContent).toBe(`${draft} for the launch`);
    expect(querySuggestions()).not.toBeInTheDocument();
    await fill(editor, "image");
    expect(editor.textContent).toBe("image");
    expect(querySuggestions()).not.toBeInTheDocument();

    await fill(editor, "");
    expect(editor.textContent).toBe("");
    await fill(editor, draft);
    const reopened = await suggestions();
    expect(
      within(reopened).getByRole("heading", { name: "Presentation" }),
    ).toBeInTheDocument();
    expect(
      within(reopened).getByRole("group", { name: "Choose a task" }),
    ).toBeInTheDocument();
    expect(editor.textContent).toBe(draft);
    expect(capture.runPrompts).toHaveLength(0);
  },
);

test("New candidates do not reopen previously dismissed types in the same draft", async () => {
  const { editor } = await setupComposer();
  await fill(editor, "image");
  click(button("Dismiss suggestions", await suggestions()));
  await waitFor(() => {
    expect(querySuggestions()).not.toBeInTheDocument();
  });
  await fill(editor, "image and a website");
  const website = await suggestions();
  expect(
    within(website).getByRole("heading", { name: "Website" }),
  ).toBeInTheDocument();
  expect(
    within(website).queryByRole("group", { name: "Choose a task" }),
  ).not.toBeInTheDocument();
  click(button("Dismiss suggestions", website));
  await waitFor(() => {
    expect(querySuggestions()).not.toBeInTheDocument();
  });
  await fill(editor, "A website, image, and document.");
  const document = await suggestions();
  expect(
    within(document).getByRole("heading", { name: "Document" }),
  ).toBeInTheDocument();
  expect(
    within(document).queryByRole("group", { name: "Choose a task" }),
  ).not.toBeInTheDocument();
  click(button("Dismiss suggestions", document));
  await waitFor(() => {
    expect(querySuggestions()).not.toBeInTheDocument();
  });
  await fill(editor, "website and image");
  expect(editor.textContent).toBe("website and image");
  expect(querySuggestions()).not.toBeInTheDocument();
});

test("An active slash menu gates full-text generation suggestions", async () => {
  const { capture, editor } = await setupComposer();
  const draft = "For this campaign, I need an image";
  await fill(editor, draft);
  await suggestions();
  const user = userEvent.setup({ delay: null });
  await user.keyboard(" /");
  await expect(
    screen.findByTestId("slash-workflow-menu"),
  ).resolves.toBeInTheDocument();
  expect(editor.textContent).toBe(`${draft} /`);
  expect(querySuggestions()).not.toBeInTheDocument();
  expect(capture.runPrompts).toHaveLength(0);

  await fill(editor, draft);
  await expect(suggestions()).resolves.toBeInTheDocument();
  expect(editor.textContent).toBe(draft);
  expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
  expect(capture.runPrompts).toHaveLength(0);
});

test("Thread suggestions sit above the composer and stay closed during IME composition", async () => {
  const { capture, editor } = await setupComposer({
    path: `/chats/${THREAD_ID}`,
  });
  await fill(editor, "image");
  const panel = await suggestions();
  expect(panel).toHaveAttribute("data-placement", "above");

  fireEvent.compositionStart(editor, { data: "image" });
  await waitFor(() => {
    expect(querySuggestions()).not.toBeInTheDocument();
  });
  fireEvent.keyDown(editor, {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(editor.textContent).toBe("image");
  expect(capture.runPrompts).toHaveLength(0);

  fireEvent.compositionEnd(editor, { data: "image" });
  const committed = await suggestions();
  expect(committed).toHaveAttribute("data-placement", "above");
  expect(editor.textContent).toBe("image");
  expect(capture.runPrompts).toHaveLength(0);
});
