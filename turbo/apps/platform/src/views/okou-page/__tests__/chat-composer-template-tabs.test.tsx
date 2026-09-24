import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";

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
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Test User",
        createdAt: new Date("2026-09-22T00:00:00.000Z"),
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: customEnabled,
      [FeatureSwitchKey.NewUserVideoPickers]: false,
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
  ).toStrictEqual([
    "Custom",
    "Presentation",
    "Website",
    "Illustration",
    "Workflow",
  ]);
  selectedPanel(dialog, "Custom");

  await user.click(tabNamed(dialog, "Custom"));
  await user.keyboard("{ArrowDown}");
  selectedPanel(dialog, "Presentation");
  expect(tabNamed(dialog, "Presentation")).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  selectedPanel(dialog, "Custom");
  expect(tabNamed(dialog, "Custom")).toHaveFocus();
});

test("Mobile category selection selects the matching panel", async () => {
  const { dialog } = await openPicker({ mobile: true });
  const category = within(dialog).getByRole("combobox", {
    name: "Template category",
  });
  expect(category).toHaveTextContent("Custom");
  click(category);
  const options = await screen.findByRole("listbox");
  click(within(options).getByRole("option", { name: "Workflow" }));
  selectedPanel(dialog, "Workflow");
  expect(category).toHaveTextContent("Workflow");
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
