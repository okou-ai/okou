import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
  expectInlineTemplate,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

function tabNamed(dialog: HTMLElement, name: string): HTMLElement {
  const tab = queryAllByRoleFast("tab", dialog).find((item) => {
    return item.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`Expected template category ${name}`);
  }
  return tab;
}

function selectedPanel(dialog: HTMLElement, name: string): HTMLElement {
  const tab = tabNamed(dialog, name);
  const panelId = tab.getAttribute("aria-controls");
  const panel = panelId ? document.getElementById(panelId) : null;
  if (!panel) {
    throw new Error(`Expected the panel controlled by ${name}`);
  }
  expect(tab).toHaveAttribute("aria-selected", "true");
  expect(dialog).toContainElement(panel);
  expect(panel).toHaveAttribute("aria-labelledby", tab.id);
  expect(panel).not.toHaveAttribute("hidden");
  expect(panel).not.toHaveAttribute("inert");
  expect(dialog.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
  return panel;
}

test("Built-in templates stay usable while custom templates load after switching categories", async () => {
  mockNow(1_785_542_400_000, context.signal);
  mockTemplateChat();
  const catalogRequested = context.mocks.deferred<void>();
  const catalog = context.mocks.deferred<void>();
  context.mocks.api(userTemplatesContract.list, async ({ respond }) => {
    if (!catalogRequested.settled()) {
      catalogRequested.resolve();
    }
    await catalog.promise;
    return respond(200, []);
  });
  const [website] = WEBSITE_TEMPLATE_ITEMS;
  const [presentation] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!website || !presentation) {
    throw new Error("Expected built-in website and presentation templates");
  }
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?templatePicker=website`,
  });
  const dialog = await screen.findByRole("dialog");
  expect(
    within(selectedPanel(dialog, "Website")).getByLabelText(
      `Select website template ${website.title}`,
    ),
  ).toBeEnabled();

  click(tabNamed(dialog, "Presentation"));
  // The picker requests custom templates once a category that offers them is
  // shown; the request stays pending for the checks below.
  await catalogRequested.promise;
  const select = within(selectedPanel(dialog, "Presentation")).getByLabelText(
    `Select template ${presentation.title}`,
  );
  expect(select).toBeEnabled();
  click(select);

  await expectInlineTemplate(presentation.title);
  catalog.resolve();
});

test("Category arrows select the matching panel and keep focus on the selected tab", async () => {
  mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, []);
  });
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 640px)";
  });
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat?compose=1` });
  const dialog = await openTemplatePicker(user);
  selectedPanel(dialog, "Presentation");
  await waitFor(() => {
    expect(tabNamed(dialog, "Presentation")).toHaveFocus();
  });

  await user.keyboard("{ArrowDown}");
  selectedPanel(dialog, "Document");
  expect(tabNamed(dialog, "Document")).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  selectedPanel(dialog, "Presentation");
  expect(tabNamed(dialog, "Presentation")).toHaveFocus();
});
