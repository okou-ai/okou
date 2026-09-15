import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockTemplateChat } from "./chat-composer-template-gallery-test-helpers.ts";
import {
  THREAD_ID,
  context,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";

async function setupComposer(
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<HTMLElement> {
  mockTemplateChat();
  await setupPage({ context, path: `/chats/${THREAD_ID}`, featureSwitches });
  return await findComposerEditor();
}

function composerCard(editor: HTMLElement): HTMLElement {
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected composer card");
  }
  return card;
}

async function openAddMenu(editor: HTMLElement): Promise<HTMLElement> {
  click(within(composerCard(editor)).getByLabelText("Add"));
  return await screen.findByRole("menu", { name: "Add" });
}

function menuItemLabels(menu: HTMLElement): string[] {
  return queryAllByRoleFast("menuitem", menu).map((item) => {
    return item.textContent?.trim() ?? "";
  });
}

function menuItem(menu: HTMLElement, label: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === label;
  });
  if (!item) {
    throw new Error(`Expected the ${label} row`);
  }
  return item;
}

test("keeps the separate attach, template and workflow buttons while the add menu is off", async () => {
  const editor = await setupComposer({
    [FeatureSwitchKey.ComposerAddMenu]: false,
  });
  const card = composerCard(editor);

  expect(within(card).getByLabelText("Attach")).toBeVisible();
  expect(within(card).getByLabelText("Template")).toBeVisible();
  expect(within(card).getByLabelText("Create workflow")).toBeVisible();
  expect(within(card).queryByLabelText("Add")).toBeNull();
});

test("collapses those buttons into the add menu's rows", async () => {
  const editor = await setupComposer({
    [FeatureSwitchKey.ComposerAddMenu]: true,
  });
  const card = composerCard(editor);

  expect(within(card).queryByLabelText("Attach")).toBeNull();
  expect(within(card).queryByLabelText("Template")).toBeNull();
  expect(within(card).queryByLabelText("Create workflow")).toBeNull();

  const menu = await openAddMenu(editor);
  expect(menuItemLabels(menu)).toStrictEqual([
    "Attach",
    "Template",
    "Create workflow",
  ]);
});

// The task chips reach a presentation, image, video, website or visualization
// in one click from directly under the composer, so the menu stays out of that
// job even where every one of those generations is switched on.
test("leaves starting a generation to the task chips", async () => {
  const editor = await setupComposer({
    [FeatureSwitchKey.ComposerAddMenu]: true,
    [FeatureSwitchKey.ComposerCreateCommands]: true,
    [FeatureSwitchKey.ComposerTaskChips]: true,
  });

  const menu = await openAddMenu(editor);
  expect(menuItemLabels(menu)).toStrictEqual([
    "Attach",
    "Template",
    "Create workflow",
  ]);
});

// The dialog used to be mounted by the toolbar button that the menu replaces.
// Reaching it from the menu row proves it survived that button's removal, which
// is also what keeps the slash panel and inline chip editing working.
test("still reaches the template picker with its toolbar button gone", async () => {
  const editor = await setupComposer({
    [FeatureSwitchKey.ComposerAddMenu]: true,
  });
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template fixture");
  }

  const menu = await openAddMenu(editor);
  click(menuItem(menu, "Template"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  await expect(
    screen.findByLabelText(`Select template ${template.title}`),
  ).resolves.toBeVisible();
});

test("opens the file picker from the attach row", async () => {
  const editor = await setupComposer({
    [FeatureSwitchKey.ComposerAddMenu]: true,
  });
  const fileInput = document.querySelector('input[type="file"]');
  if (!(fileInput instanceof HTMLInputElement)) {
    throw new Error("Expected the composer file input");
  }
  let clicks = 0;
  fileInput.addEventListener("click", (event) => {
    event.preventDefault();
    clicks += 1;
  });

  const menu = await openAddMenu(editor);
  click(menuItem(menu, "Attach"));

  expect(clicks).toBe(1);
});
