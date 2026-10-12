import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import {
  chooseCommand,
  setupComposer,
  setupModels,
} from "./chat-composer-create-test-helpers.ts";
import { openTemplatePicker } from "./chat-composer-template-gallery-test-helpers.ts";
import {
  composerInlineTemplates,
  context,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

function inlineTemplateCover(index = 0): HTMLImageElement | null {
  const chip = composerInlineTemplates()[index];
  if (!chip) {
    throw new Error(`Expected an inline template at ${index}`);
  }
  return chip.querySelector("img");
}

async function addPresentationTemplate(
  editor: HTMLElement,
  title: string,
): Promise<void> {
  await chooseCommand(editor, "Our launch /", "presentation");
  await clickComposerAddMenuItem("Add template");
  await screen.findByRole("dialog");
  click(await screen.findByLabelText(`Select template ${title}`));
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
}

async function setupCoveredPresentationTemplate() {
  setupModels();
  mockChatLifecycle(context);
  const editor = await setupComposer();
  const [first] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first) {
    throw new Error("Expected a presentation template");
  }
  await addPresentationTemplate(editor, first.title);
  return { first };
}

test("An inline template chip shows the chosen cover", async () => {
  const { first } = await setupCoveredPresentationTemplate();
  await waitFor(() => {
    expect(inlineTemplateCover()?.getAttribute("src")).toContain(first.slug);
  });
  expect(composerInlineTemplates()[0]).toHaveTextContent(first.title);
});

test("A template with no cover keeps the template glyph on its chip", async () => {
  setupModels();
  mockChatLifecycle(context);
  await setupComposer();
  const [template] = WEBSITE_TEMPLATE_ITEMS;
  if (!template) {
    throw new Error("Expected a website template");
  }
  await openTemplatePicker(userEvent.setup({ delay: null }), "Website");
  click(
    await screen.findByLabelText(`Select website template ${template.title}`),
  );
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
  expect(inlineTemplateCover()).toBeNull();
});
