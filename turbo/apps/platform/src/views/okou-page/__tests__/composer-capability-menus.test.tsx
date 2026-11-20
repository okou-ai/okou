import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import { createTemplateGalleryHelpers } from "./chat-composer-template-gallery-test-helpers.ts";
import {
  composerWorkflow,
  findComposerEditor,
  THREAD_ID,
} from "./chat-composer-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
const DRAFT = "Plan the offsite";

async function composerCard(): Promise<HTMLElement> {
  const editor = await findComposerEditor();
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected the composer card");
  }
  return card;
}

async function typeDraft(text: string): Promise<void> {
  const user = userEvent.setup({ delay: null });
  await user.click(await findComposerEditor());
  await user.paste(text);
  await expect(findComposerEditor()).resolves.toHaveTextContent(text.trim());
}

function labelled(container: ParentNode, label: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

/** The open menu or dialog whose accessible name is `name`. */
async function findPopup(
  role: "menu" | "dialog",
  name: string,
): Promise<HTMLElement> {
  return await waitFor(() => {
    const popup = [
      ...document.querySelectorAll<HTMLElement>(`[role="${role}"]`),
    ].find((candidate) => {
      const labelledBy = candidate.getAttribute("aria-labelledby");
      const label =
        candidate.getAttribute("aria-label") ??
        (labelledBy ? document.getElementById(labelledBy)?.textContent : null);
      return label?.trim() === name;
    });
    if (!popup) {
      throw new Error(`Expected the ${name} ${role}`);
    }
    return popup;
  });
}

async function chooseAddItem(name: string): Promise<void> {
  click(labelled(await composerCard(), "Add") as HTMLElement);
  const menu = await findPopup("menu", "Add");
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected the ${name} item`);
  }
  click(item);
}

function capability(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
}

async function expectComposerFocusedWithDraft(): Promise<void> {
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(document.activeElement).toBe(editor);
  });
  expect(editor).toHaveTextContent(DRAFT);
}

test("A successful send dismisses menu discovery in an existing conversation", async () => {
  mockTemplateChat();
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  await typeDraft("Draft the launch recap");
  await chooseAddItem("Research");
  await waitFor(() => {
    expect(capability("Research")).toBeInTheDocument();
  });

  await userEvent.keyboard("{Enter}");

  await expect(
    screen.findByText("Draft the launch recap", {
      selector: "[data-role='user'] *",
    }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(capability("Research")).not.toBeInTheDocument();
  });
  expect(window.location.pathname).toBe(`/chats/${THREAD_ID}`);
});

function useDesktopLayout(): void {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
}

function slashMenuItems(): HTMLElement[] {
  const menu = document.querySelector<HTMLElement>("[role=dialog]");
  return menu ? [...menu.querySelectorAll<HTMLElement>("button")] : [];
}

test("Slash capabilities preserve the draft with SlashActions=false and desktop=true", async () => {
  useDesktopLayout();
  mockTemplateChat();
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [
      composerWorkflow("daily-recap", "Summarize yesterday's work"),
    ]);
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.SlashActions]: false },
  });
  await typeDraft(`${DRAFT} `);
  const card = await composerCard();
  const user = userEvent.setup({ delay: null });

  await user.keyboard("/");

  await waitFor(() => {
    expect(
      slashMenuItems().map((item) => {
        return item.textContent?.replace(/\s+/gu, " ").trim();
      }),
    ).toStrictEqual([
      "/daily-recap Summarize yesterday's work",
      "Workflow",
      "Create",
      "Research",
      "Find people",
      "Browse all templates",
    ]);
  });

  let first = true;
  for (const [name, chip] of [
    ["Find people", "Remove Find people"],
    ["Research", "Remove Research"],
    ["Create", "Remove Presentation"],
    ["Workflow", "Remove Workflow"],
  ] as const) {
    if (!first) {
      await user.keyboard("/");
    }
    first = false;
    const item = await waitFor(() => {
      const found = slashMenuItems().find((candidate) => {
        return candidate.textContent?.trim() === name;
      });
      if (!found) {
        throw new Error(`Expected the ${name} slash item`);
      }
      return found;
    });
    click(item);
    await waitFor(() => {
      expect(labelled(card, chip)).toBeInTheDocument();
    });
    // The slash that opened the menu is consumed; the draft stays.
    const editor = await findComposerEditor();
    expect(editor.textContent?.trim()).toBe(DRAFT);
    expect(window.location.pathname).toBe(`/chats/${THREAD_ID}`);
  }
});

test("The Templates browser preserves the draft when opening its picker", async () => {
  useDesktopLayout();
  mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    featureSwitches: { [FeatureSwitchKey.SlashActions]: true },
  });
  await typeDraft(`${DRAFT} `);
  const user = userEvent.setup({ delay: null });
  await user.keyboard("/");
  const templates = await waitFor(() => {
    const found = slashMenuItems().find((item) => {
      return item.textContent?.startsWith("Templates");
    });
    if (!found) {
      throw new Error("Expected the Templates slash entry");
    }
    return found;
  });

  // Pointing at the entry opens its templates beside the menu.
  fireEvent.mouseMove(templates);
  const flyout = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      '[data-slot="slash-flyout"]',
    );
    if (!found) {
      throw new Error("Expected the templates flyout");
    }
    return found;
  });
  const category = (name: string): HTMLElement | undefined => {
    return queryAllByRoleFast("button", flyout).find((button) => {
      return button.textContent?.startsWith(name);
    });
  };
  click(category("Website") as HTMLElement);
  await waitFor(() => {
    expect(category("Website")).toHaveAttribute("aria-pressed", "true");
  });

  const browse = queryAllByRoleFast("button", flyout).find((button) => {
    return button.textContent?.trim() === "Browse all templates";
  });
  click(browse as HTMLElement);

  const picker = await findPopup("dialog", "Template");
  const selected = queryAllByRoleFast("tab", picker)
    .filter((tab) => {
      return tab.getAttribute("aria-selected") === "true";
    })
    .map((tab) => {
      return tab.textContent?.trim();
    });
  expect(selected).toStrictEqual(["Presentation"]);
  const editor = await findComposerEditor();
  expect(editor.textContent?.trim()).toBe(DRAFT);
  expect(editor.textContent).not.toContain("/");
});

test("The add menu opens each home capability and restores its own trigger only on dismissal", async () => {
  mockTemplateChat();
  await setupPage({ context, path: "/" });
  await typeDraft(DRAFT);
  const homeChat = window.location.pathname;
  const card = await composerCard();
  const attach = card.querySelector<HTMLInputElement>(
    'input[aria-label="Attach"]',
  );
  if (!attach) {
    throw new Error("Expected the Attach file input");
  }
  // Happy DOM has no native file picker, so its opening is recorded here.
  const picker = { opened: false };
  Object.defineProperty(attach, "showPicker", {
    value: () => {
      picker.opened = true;
    },
  });

  click(labelled(card, "Add") as HTMLElement);
  const menu = await findPopup("menu", "Add");
  expect(
    queryAllByRoleFast("menuitem", menu).map((item) => {
      return item.textContent?.trim();
    }),
  ).toStrictEqual([
    "Attach",
    "Template",
    "Find people",
    "Research",
    "Create",
    "Workflow",
    "Import skills",
  ]);
  const template = queryAllByRoleFast("menuitem", menu).find((item) => {
    return item.textContent?.trim() === "Template";
  });
  click(template as HTMLElement);
  await expect(findPopup("dialog", "Template")).resolves.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expectComposerFocusedWithDraft();

  for (const name of ["Find people", "Research"]) {
    await chooseAddItem(name);
    await waitFor(() => {
      expect(capability(name)).toBeInTheDocument();
    });
    expect(labelled(card, `Remove ${name}`)).toBeInTheDocument();
    await expectComposerFocusedWithDraft();
  }

  await chooseAddItem("Create");
  await expect(
    waitFor(() => {
      return labelled(card, "Remove Presentation");
    }),
  ).resolves.toBeInTheDocument();
  await expectComposerFocusedWithDraft();

  await chooseAddItem("Workflow");
  await waitFor(() => {
    expect(labelled(card, "Remove Workflow")).toBeInTheDocument();
  });
  await expectComposerFocusedWithDraft();

  await chooseAddItem("Import skills");
  await expect(
    findPopup("dialog", "Import your skills"),
  ).resolves.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expectComposerFocusedWithDraft();

  // Attach hands off to the browser's file picker; the draft stays.
  await chooseAddItem("Attach");
  await waitFor(() => {
    expect(picker.opened).toBeTruthy();
  });
  await expect(findComposerEditor()).resolves.toHaveTextContent(DRAFT);
  expect(window.location.pathname).toBe(homeChat);

  // Dismissing the menu, rather than choosing an item, restores its trigger.
  await userEvent.click(await findComposerEditor());
  click(labelled(card, "Add") as HTMLElement);
  await findPopup("menu", "Add");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(document.activeElement).toBe(labelled(card, "Add"));
  });
});
