import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
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
  category,
  customEnabled = true,
  mobile = false,
}: {
  category?: "slides" | "video";
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
    path: `/agents/${AGENT_ID}/chat${category ? `?templatePicker=${category}` : ""}`,
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
  const dialog = category
    ? await screen.findByRole("dialog")
    : await openTemplatePicker(user);
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

test("Category navigation wraps and Home and End select the first and last panels", async () => {
  const { user, dialog } = await openPicker();
  await user.click(tabNamed(dialog, "Custom"));
  await user.keyboard("{ArrowUp}");
  selectedPanel(dialog, "Workflow");
  await user.keyboard("{ArrowDown}");
  selectedPanel(dialog, "Custom");
  await user.keyboard("{End}");
  selectedPanel(dialog, "Workflow");
  expect(tabNamed(dialog, "Workflow")).toHaveFocus();
  await user.keyboard("{Home}");
  selectedPanel(dialog, "Custom");
  expect(tabNamed(dialog, "Custom")).toHaveFocus();
});

test("Tab enters the selected panel and its search keeps text editing keys", async () => {
  const { user, dialog } = await openPicker();
  await user.click(tabNamed(dialog, "Workflow"));
  const panel = selectedPanel(dialog, "Workflow");
  await user.keyboard("{Tab}");
  expect(panel).toHaveFocus();
  await user.keyboard("{Tab}");
  const search = within(panel).getByRole("textbox", {
    name: "Search templates",
  });
  expect(search).toHaveFocus();
  await user.keyboard("calendar{Home}{ArrowDown}{End}{ArrowUp}");
  expect(search).toHaveValue("calendar");
  expect(search).toHaveFocus();
  selectedPanel(dialog, "Workflow");
});

test("Mobile category selection and desktop tabs share one selected panel", async () => {
  const { user, dialog } = await openPicker({ mobile: true });
  const category = within(dialog).getByRole("combobox", {
    name: "Template category",
  });
  expect(category).toHaveTextContent("Custom");
  click(category);
  const options = await screen.findByRole("listbox");
  click(within(options).getByRole("option", { name: "Workflow" }));
  selectedPanel(dialog, "Workflow");
  expect(category).toHaveTextContent("Workflow");

  await user.click(tabNamed(dialog, "Workflow"));
  await user.keyboard("{Home}");
  selectedPanel(dialog, "Custom");
  expect(category).toHaveTextContent("Custom");
  expect(within(dialog).getAllByLabelText("Import template")).toHaveLength(1);
});

test.each([
  { entry: "the ordinary picker", category: undefined },
  { entry: "a video link", category: "video" as const },
])(
  "Unavailable categories stay hidden and $entry opens the Presentation tab and panel",
  async ({ category }) => {
    const { dialog } = await openPicker({ category, customEnabled: false });
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
  },
);

test("Changing category unmounts inactive content while retaining workflow search and presentation scroll", async () => {
  const { user, dialog } = await openPicker({ category: "slides" });
  const presentation = selectedPanel(dialog, "Presentation");
  const grid = presentation.querySelector<HTMLElement>(
    "[data-presentation-template-grid-scroll]",
  );
  if (!grid) {
    throw new Error("Expected the presentation grid scroll surface");
  }
  fireEvent.scroll(grid, { target: { scrollTop: 240 } });

  await user.click(tabNamed(dialog, "Presentation"));
  await user.keyboard("{End}");
  const workflow = selectedPanel(dialog, "Workflow");
  expect(
    dialog.querySelector("[data-presentation-template-grid-scroll]"),
  ).not.toBeInTheDocument();
  await fill(
    within(workflow).getByRole("textbox", { name: "Search templates" }),
    "calendar",
  );

  await user.click(tabNamed(dialog, "Presentation"));
  const restored = selectedPanel(dialog, "Presentation");
  expect(
    restored.querySelector<HTMLElement>(
      "[data-presentation-template-grid-scroll]",
    )?.scrollTop,
  ).toBe(240);
  expect(
    within(dialog).queryByRole("textbox", { name: "Search templates" }),
  ).not.toBeInTheDocument();

  await user.keyboard("{End}");
  expect(
    within(selectedPanel(dialog, "Workflow")).getByRole("textbox", {
      name: "Search templates",
    }),
  ).toHaveValue("calendar");
});
