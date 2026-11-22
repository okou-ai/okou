import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import {
  queryAllByRoleFast,
  setupPage,
  click,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findComposerEditor,
  expectInlineTemplateInComposer,
} from "./chat-composer-test-helpers.ts";
import { createTemplateGalleryHelpers } from "./chat-composer-template-gallery-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext(),
  draft = "Outline the harbor launch.";
const options = Object.freeze([
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
async function home() {
  const sent = createTemplateGalleryHelpers(context).mockTemplateChat();
  await setupPage({ context, path: "/" });
  return { sent, editor: await findComposerEditor() };
}
async function press(name: string) {
  click(await findFastControl("button", name));
}
async function countSlides() {
  click(await screen.findByRole("combobox", { name: "Slide count" }));
  click(await screen.findByRole("option", { name: /16.20 slides/ }));
}
async function workflows() {
  await press("Advanced workflows");
  await screen.findByText(options[0]!);
}
test("composer-task-chips-001 removing Presentation preserves the user's original draft", async () => {
  const { editor } = await home();
  await press("Presentation");
  await fill(editor, draft);
  await press("Remove Presentation");
  expect(editor.textContent).toBe(draft);
  expect(queryFastControl("button", "Remove Presentation")).toBeNull();
});
test("composer-task-chips-002 a launch deck keeps its 16–20 slide setting on the destination conversation", async () => {
  const { editor, sent } = await home();
  await press("Presentation");
  await countSlides();
  await fill(editor, draft);
  await press("Send");
  await waitFor(() => {
    expect(sent.sentMessages[0]?.parts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "additional_info",
          text: expect.stringContaining("Slide count: 16-20"),
        }),
      ]),
    );
    expect(sent.runPrompts[0]).toContain(draft);
    expect(location.pathname).toMatch(/^.chats./);
  });
  await findFastControl("button", "Remove Presentation");
  await expect(
    screen.findByRole("combobox", { name: "Slide count" }),
  ).resolves.toHaveTextContent(/16.20/);
});
test("composer-task-chips-007 choosing an image from the catalog replaces Presentation and sends the image template", async () => {
  const { editor, sent } = await home();
  await press("Presentation");
  await fill(editor, draft);
  await press("View all");
  const dialog = await screen.findByRole("dialog");
  click(await findFastControl("tab", "Image", dialog));
  const pick = await findFastControl("button", /^Select template /i, dialog);
  const title = pick
    .getAttribute("aria-label")!
    .replace(/^Select template /i, "");
  click(pick);
  await expectInlineTemplateInComposer(title);
  expect(editor).toHaveTextContent(draft);
  await findFastControl("button", "Remove Image");
  expect(screen.queryByRole("combobox", { name: "Slide count" })).toBeNull();
  await press("Send");
  await waitFor(() => {
    expect(sent.selectedTemplates[0]).toMatchObject({ type: "illustration" });
    expect(sent.sentMessages[0]?.parts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "additional_info",
          text: expect.stringMatching(/Create an image/i),
        }),
      ]),
    );
  });
});
test("composer-task-chips-011 opening and closing the presentation catalog preserves the draft", async () => {
  const { editor } = await home();
  await press("Presentation");
  await fill(editor, draft);
  await press("View all");
  const dialog = await screen.findByRole("dialog");
  await expect(
    findFastControl("tab", "Presentation", dialog),
  ).resolves.toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(editor.textContent).toBe(draft);
});
test("composer-task-chips-012 Website presents the full recommendation shelf and attaches the chosen template", async () => {
  const { editor } = await home();
  await press("Website");
  await fill(editor, draft);
  const shelf = await screen.findByRole("group", { name: "Website templates" });
  const choices = queryAllByRoleFast("button", shelf).filter((button) => {
    return /^Use template /i.test(button.getAttribute("aria-label") ?? "");
  });
  expect(choices.length).toBeGreaterThan(5);
  await findFastControl("button", "View all");
  const choice = choices[4]!;
  const title = choice
    .getAttribute("aria-label")!
    .replace(/^Use template /i, "");
  click(choice);
  await expectInlineTemplateInComposer(title);
  expect(editor).toHaveTextContent(draft);
});
test("composer-task-chips-015 Advanced workflows keeps nine ordered recommendations beside the unsent draft", async () => {
  const { editor, sent } = await home();
  await workflows();
  const shelf = Array.from(
    document.querySelectorAll('[data-slot="workflow-recommendation-tile"]'),
  );
  expect(
    shelf.map((s) => {
      return s.getAttribute("aria-label") ?? s.textContent?.trim();
    }),
  ).toStrictEqual(options);
  await fill(editor, draft);
  expect(editor.textContent).toBe(draft);
  expect(location.pathname).toBe("/");
  expect(sent.runPrompts).toStrictEqual([]);
});
test("composer-task-chips-017 viewing all workflows opens their catalog and preserves the unsent draft", async () => {
  const { editor, sent } = await home();
  await workflows();
  await fill(editor, draft);
  await press("View all");
  const dialog = await screen.findByRole("dialog");
  await expect(
    findFastControl("tab", "Workflow", dialog),
  ).resolves.toHaveAttribute("aria-selected", "true");
  await within(dialog).findByText("Morning brief");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(editor.textContent).toBe(draft);
  expect(sent.runPrompts).toStrictEqual([]);
});
test("composer-task-chips-018 editing the prepared morning brief keeps focus, the draft and the workflow identity", async () => {
  const { editor, sent } = await home();
  await workflows();
  await fill(editor, draft);
  click(await screen.findByText(options[0]!));
  await expectInlineTemplateInComposer("Morning brief");
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent(draft);
  await userEvent.setup().paste(" Include the tides.");
  expect(editor).toHaveTextContent("Include the tides.");
  await press("Send");
  await waitFor(() => {
    expect(sent.selectedTemplates[0]).toMatchObject({
      type: "workflow",
      selection: { workflowTemplateId: "workflow-template:morning-brief" },
    });
    expect(sent.runPrompts[0]).toContain("Include the tides.");
  });
});
test("composer-task-chips-019 the reply recommendation prepares one Gmail watch with no attached template", async () => {
  const { editor, sent } = await home();
  await workflows();
  click(await screen.findByText(options.at(-1)!));
  await waitFor(() => {
    expect(editor).toHaveTextContent("watch one Gmail conversation");
  });
  expect(sent.runPrompts).toStrictEqual([]);
  await press("Send");
  await waitFor(() => {
    expect(sent.runPrompts[0]).toContain("watch one Gmail conversation");
  });
  expect(
    sent.sentMessages[0]?.parts.some((p) => {
      return p.type === "template";
    }),
  ).toBeFalsy();
});
