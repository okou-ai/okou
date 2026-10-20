import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  AGENT_ID,
  context,
  createUploadedTemplate,
  expectInlineTemplate,
  mockPresentationTemplateLibrary,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";

test("Website stays usable while uploaded presentations load after switching categories", async () => {
  mockNow(1_785_542_400_000, context.signal);
  mockTemplateChat();
  const uploaded = createUploadedTemplate({
    id: "82000000-0000-4000-a000-000000000001",
    title: "Launch presentation",
  });
  mockPresentationTemplateLibrary([uploaded]);
  const catalog = createDeferredPromise<void>(context.signal);
  context.mocks.api(presentationTemplatesContract.list, async ({ respond }) => {
    await catalog.promise;
    return respond(200, [uploaded]);
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?templatePicker=website`,
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: false },
  });
  const dialog = await screen.findByRole("dialog");
  const website = WEBSITE_TEMPLATE_ITEMS[0]!;
  const presentation = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
  expect(
    within(selectedPanel(dialog, "Website")).getByLabelText(
      `Select website template ${website.title}`,
    ),
  ).toBeEnabled();
  click(tabNamed(dialog, "Presentation"));
  expect(
    within(selectedPanel(dialog, "Presentation")).getByLabelText(
      `Select template ${presentation.title}`,
    ),
  ).toBeEnabled();
  catalog.resolve();
  const uploadedChoice = await within(dialog).findByLabelText(
    `Select template ${uploaded.title}`,
  );
  click(uploadedChoice);
  await expectInlineTemplate(uploaded.title);
});

async function openPicker({
  customEnabled = true,
  mobile = false,
}: {
  customEnabled?: boolean;
  mobile?: boolean;
} = {}) {
  mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, []);
  });
  context.mocks.browser.matchMedia((query) => {
    return mobile
      ? query === "(pointer: coarse)"
      : query === "(min-width: 640px)";
  });
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: customEnabled,
    },
  });
  const dialog = await openTemplatePicker(user);
  return { user, dialog };
}

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
  expect(panel).toHaveAttribute("role", "tabpanel");
  expect(panel).toHaveAttribute("aria-labelledby", tab.id);
  expect(panel).toHaveAccessibleName(name);
  expect(panel).not.toHaveAttribute("hidden");
  expect(panel).not.toHaveAttribute("inert");
  expect(dialog.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
  return panel;
}

test("Category arrows select the matching panel and keep focus on the selected tab", async () => {
  const { user, dialog } = await openPicker();
  const list = within(dialog).getByRole("tablist", {
    name: "Template categories",
  });
  expect(list).toHaveAttribute("aria-orientation", "vertical");
  expect(
    queryAllByRoleFast("tab", list).map((tab) => {
      return tab.textContent;
    }),
  ).toStrictEqual(["Presentation", "Document", "Website", "Image", "Workflow"]);
  selectedPanel(dialog, "Presentation");
  await waitFor(() => {
    expect(tabNamed(dialog, "Presentation")).toHaveFocus();
  });

  await user.click(tabNamed(dialog, "Presentation"));
  await user.keyboard("{ArrowDown}");
  selectedPanel(dialog, "Document");
  expect(tabNamed(dialog, "Document")).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  selectedPanel(dialog, "Presentation");
  expect(tabNamed(dialog, "Presentation")).toHaveFocus();
});

test("Mobile category selection selects the matching panel", async () => {
  const { dialog } = await openPicker({ mobile: true });
  const category = within(dialog).getByRole("combobox", {
    name: "Template category",
  });
  expect(category).toHaveTextContent("Presentation");
  await waitFor(() => {
    expect(category).toHaveFocus();
  });
  click(category);
  const options = await screen.findByRole("listbox");
  click(within(options).getByRole("option", { name: "Workflow" }));
  selectedPanel(dialog, "Workflow");
  expect(category).toHaveTextContent("Workflow");
});

test("Reopening the template picker focuses its current category control", async () => {
  const { user, dialog } = await openPicker();
  await waitFor(() => {
    expect(tabNamed(dialog, "Presentation")).toHaveFocus();
  });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  const reopened = await openTemplatePicker(user);
  await waitFor(() => {
    expect(tabNamed(reopened, "Presentation")).toHaveFocus();
  });
});

test("Unavailable categories stay hidden and the ordinary picker opens the Presentation tab and panel", async () => {
  const { dialog } = await openPicker({ customEnabled: false });
  selectedPanel(dialog, "Presentation");
  const list = within(dialog).getByRole("tablist", {
    name: "Template categories",
  });
  expect(
    queryAllByRoleFast("tab", list).map((tab) => {
      return tab.textContent;
    }),
  ).toStrictEqual(["Presentation", "Website", "Illustration", "Workflow"]);
  expect(
    within(dialog).getByRole("combobox", { name: "Template category" }),
  ).toHaveTextContent("Presentation");
});
