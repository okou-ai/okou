import {
  chatEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { DOCUMENT_TEMPLATE_ITEMS } from "@okouai/core/document-template-items";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
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
  task: "Presentation" | "Image" | "Document",
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

test("Escape closes recommendations without submitting or changing the draft", async () => {
  const { capture, editor } = await setupComposer();
  await fill(editor, "slide");
  await suggestions();
  fireEvent.keyDown(editor, { key: "Escape" });
  await waitFor(() => {
    expect(querySuggestions()).not.toBeInTheDocument();
  });
  expect(editor.textContent).toBe("slide");
  expect(capture.runPrompts).toHaveLength(0);
  expect(editor).toHaveFocus();
});

test("A bare doc offers document settings without changing or sending the text", async () => {
  const { capture, editor } = await setupComposer();
  await fill(editor, "doc");
  const panel = await suggestions();
  expect(
    within(panel).getByRole("heading", { name: "Document" }),
  ).toBeInTheDocument();
  expect(button("Apply settings", panel)).toBeEnabled();
  expect(editor.textContent).toBe("doc");
  expect(capture.runPrompts).toHaveLength(0);

  await applySettings(panel, "Document");
  expect(editor.textContent).toBe("doc");
  expect(capture.runPrompts).toHaveLength(0);
});

test.each([
  { output: "Document", intent: "Create a document." },
  { output: "Presentation", intent: "Create a presentation." },
] as const)(
  "A report requires an explicit $output choice before applying settings",
  async ({ output, intent }) => {
    const { capture, editor } = await setupComposer();
    await fill(editor, "report");
    const panel = await suggestions();
    const apply = button("Apply settings", panel);
    expect(apply).toBeDisabled();
    expect(button("Document", panel)).toHaveAttribute("aria-pressed", "false");
    expect(button("Presentation", panel)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    click(button(output, panel));
    await waitFor(() => {
      expect(apply).toBeEnabled();
    });
    expect(button(output, panel)).toHaveAttribute("aria-pressed", "true");
    expect(editor.textContent).toBe("report");
    expect(capture.runPrompts).toHaveLength(0);

    await applySettings(panel, output);
    expect(editor.textContent).toBe("report");
    expect(capture.runPrompts).toHaveLength(0);
    click(button("Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(capture.runPrompts).toStrictEqual(["report"]);
    expect(messageText(capture.sentMessages[0])).toBe("report");
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining(intent),
    });
  },
);

test("Changing a report format removes only its recommendation-owned template", async () => {
  const { capture, editor } = await setupComposer();
  const documentTemplate = DOCUMENT_TEMPLATE_ITEMS.find((item) => {
    return item.category === "report";
  });
  const [presentationTemplate, nextPresentationTemplate] =
    PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!documentTemplate || !presentationTemplate || !nextPresentationTemplate) {
    throw new Error("Expected document and presentation templates");
  }
  await fill(editor, "report");
  click(button(`Use template ${documentTemplate.title}`, await suggestions()));
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
  click(button("Change generation settings"));
  const changes = await suggestions();
  click(button("Presentation", changes));
  await applySettings(changes, "Presentation");
  expect(composerInlineTemplates()).toHaveLength(0);
  expect(editor.textContent?.trim()).toBe("report");
  click(button("Change generation settings"));
  click(
    button(`Use template ${presentationTemplate.title}`, await suggestions()),
  );
  click(button("Change generation settings"));
  click(
    button(
      `Use template ${nextPresentationTemplate.title}`,
      await suggestions(),
    ),
  );
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
    expect(composerInlineTemplates()[0]).toHaveTextContent(
      nextPresentationTemplate.title,
    );
  });
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.selectedTemplates).toHaveLength(1);
  expect(capture.selectedTemplates[0]).toMatchObject({
    type: "presentation",
    selection: { templateId: nextPresentationTemplate.templateId },
  });
  expect(messageText(capture.sentMessages[0])).toBe("report");
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

test("Dismissal survives edits of the same intent until the draft is cleared", async () => {
  const { capture, editor } = await setupComposer();
  const user = userEvent.setup({ delay: null });
  await fill(editor, "slide");
  const panel = await suggestions();
  click(button("Dismiss suggestions", panel));
  await screen.findByRole("group", { name: "Choose a task" });
  expect(querySuggestions()).not.toBeInTheDocument();
  expect(editor).toHaveFocus();
  expect(editor.textContent).toBe("slide");

  await user.keyboard("s");
  expect(editor.textContent).toBe("slides");
  expect(querySuggestions()).not.toBeInTheDocument();
  expect(capture.runPrompts).toHaveLength(0);

  await fill(editor, "");
  expect(editor.textContent).toBe("");
  await fill(editor, "slide");
  await expect(suggestions()).resolves.toBeInTheDocument();
  expect(editor.textContent).toBe("slide");
  expect(capture.runPrompts).toHaveLength(0);
});

test("Dismissing a different intent does not forget earlier dismissals in the same draft", async () => {
  const { editor } = await setupComposer();
  await fill(editor, "slide");
  click(button("Dismiss suggestions", await suggestions()));
  await fill(editor, "image");
  click(button("Dismiss suggestions", await suggestions()));
  await fill(editor, "slide");
  expect(querySuggestions()).not.toBeInTheDocument();
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
