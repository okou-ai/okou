import {
  userTemplatesContract,
  type UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, waitFor, within } from "@testing-library/react";
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

function customTemplate(
  overrides: Partial<UserTemplateDetail> = {},
): UserTemplateDetail {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Q3 board review",
    sourceFilename: "q3-board-final-v4.pptx",
    kind: "presentation",
    coverUrl: "https://example.test/cover.png",
    pageCount: 18,
    visibility: "private",
    ownerUserId: "user_self",
    canManage: true,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    pageUrls: ["https://example.test/page-1.png"],
    previewAssets: [],
    ...overrides,
  };
}

function mockCustomTemplates(templates: readonly UserTemplateDetail[]): void {
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(
      200,
      templates.map(({ pageUrls: _pageUrls, ...entry }) => {
        return entry;
      }),
    );
  });
}

/**
 * List, detail and update served from one mutable array, so a mutation is
 * observable the only way a user can observe it: by looking at the panel again.
 */
function mockCustomTemplateStore(initial: readonly UserTemplateDetail[]): void {
  const templates = [...initial];
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(
      200,
      templates.map(({ pageUrls: _pageUrls, ...entry }) => {
        return entry;
      }),
    );
  });
  context.mocks.api(userTemplatesContract.get, ({ params, respond }) => {
    const template = templates.find((candidate) => {
      return candidate.id === params.templateId;
    });
    if (!template) {
      throw new Error(`No template mocked for ${params.templateId}`);
    }
    return respond(200, template);
  });
  context.mocks.api(
    userTemplatesContract.update,
    ({ body, params, respond }) => {
      const index = templates.findIndex((candidate) => {
        return candidate.id === params.templateId;
      });
      const current = templates[index];
      if (!current) {
        throw new Error(`No template mocked for ${params.templateId}`);
      }
      const updated: UserTemplateDetail = {
        ...current,
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.visibility === undefined
          ? {}
          : { visibility: body.visibility }),
      };
      templates[index] = updated;
      const {
        pageUrls: _pageUrls,
        previewAssets: _previewAssets,
        ...summary
      } = updated;
      return respond(200, summary);
    },
  );
}

function queryTabByText(text: string): HTMLElement | undefined {
  return queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
}

function tabByText(text: string): HTMLElement {
  const tab = queryTabByText(text);
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
}

function buttonByName(name: string, container: ParentNode = document.body) {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

function menuItemByName(name: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected a menu item named "${name}"`);
  }
  return item;
}

async function openCustomPanel(enabled = true) {
  const user = userEvent.setup({ delay: null });
  mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: enabled },
  });
  const dialog = await openTemplatePicker(user);
  return { user, dialog };
}

test("The Custom category stays hidden while the switch is off", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel(false);

  // The seven format categories are untouched.
  expect(queryTabByText("Presentation")).toBeTruthy();
  expect(queryTabByText("Custom")).toBeUndefined();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();
});

test("The Custom category lists every reachable template", async () => {
  mockCustomTemplates([
    customTemplate(),
    customTemplate({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Partner QBR",
      sourceFilename: "partner-qbr-q3.pptx",
      visibility: "organization",
      ownerUserId: "user_colleague",
      canManage: false,
    }),
  ]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByText("Partner QBR")).toBeInTheDocument();
});

test("A colleague's template names its owner and offers no management", async () => {
  mockCustomTemplates([
    customTemplate({ title: "Mine" }),
    customTemplate({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Theirs",
      ownerUserId: "user_colleague",
      canManage: false,
    }),
  ]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await expect(
    within(dialog).findByText("Theirs"),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).getByText("Shared by user_colleague"),
  ).toBeInTheDocument();
  expect(buttonByName("Actions for Theirs", dialog)).toBeUndefined();
  expect(buttonByName("Actions for Mine", dialog)).toBeTruthy();
});

test("Search matches the source file name, not only the title", async () => {
  mockCustomTemplates([
    customTemplate({ title: "Q3 board review" }),
    customTemplate({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Renewal deck",
      sourceFilename: "partner-qbr-q3.pptx",
    }),
  ]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByText("Renewal deck");

  fireEvent.change(within(dialog).getByPlaceholderText("Search templates"), {
    target: { value: "partner-qbr" },
  });

  await waitFor(() => {
    expect(
      within(dialog).queryByText("Q3 board review"),
    ).not.toBeInTheDocument();
  });
  expect(within(dialog).getByText("Renewal deck")).toBeInTheDocument();
});

test("A search that matches nothing reuses the picker's no-match panel", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByText("Q3 board review");

  fireEvent.change(within(dialog).getByPlaceholderText("Search templates"), {
    target: { value: "nothing matches" },
  });

  await expect(
    within(dialog).findByText("No matches"),
  ).resolves.toBeInTheDocument();
});

test("An empty catalog explains what will appear instead of showing no matches", async () => {
  mockCustomTemplates([]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await expect(
    within(dialog).findByText("No templates yet"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("No matches")).not.toBeInTheDocument();
});

test("Opening a custom template shows its pages and management controls", async () => {
  mockCustomTemplates([customTemplate()]);
  context.mocks.api(userTemplatesContract.get, ({ respond }) => {
    return respond(200, customTemplate());
  });

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByText("Q3 board review");

  click(buttonByName("Preview Q3 board review", dialog)!);

  await expect(
    within(dialog).findByText("18 pages · from q3-board-final-v4.pptx"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByLabelText("Rename template")).toBeInTheDocument();
  // Selection is deliberately absent until the `user-template:` path is
  // repointed at this table.
  expect(buttonByName("Use", dialog)).toBeUndefined();
  expect(buttonByName("Use this template", dialog)).toBeUndefined();
});

test("A document template is described by its file, not by a page count", async () => {
  const documentTemplate = customTemplate({
    id: "33333333-3333-4333-8333-333333333333",
    title: "Brand report",
    sourceFilename: "brand-report.docx",
    kind: "document",
    coverUrl: null,
    pageCount: null,
    pageUrls: [],
  });
  mockCustomTemplates([documentTemplate]);
  context.mocks.api(userTemplatesContract.get, ({ respond }) => {
    return respond(200, documentTemplate);
  });

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  // A document is its styles. The card still names the file it was compiled
  // from, and claims no pages rather than reporting zero of them.
  await expect(
    within(dialog).findByText("brand-report.docx"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("0 pages")).not.toBeInTheDocument();

  click(buttonByName("Preview Brand report", dialog)!);

  await expect(
    within(dialog).findByText("From brand-report.docx"),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).queryByText("0 pages · from brand-report.docx"),
  ).not.toBeInTheDocument();
});

async function openDetail(
  dialog: HTMLElement,
  title: string,
): Promise<HTMLElement> {
  click(tabByText("Custom"));
  await within(dialog).findByText(title);
  click(buttonByName(`Preview ${title}`, dialog)!);
  return within(dialog).findByLabelText("Rename template");
}

test("Clearing the title and leaving the field keeps the template named", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();
  const input = await openDetail(dialog, "Q3 board review");

  await fill(input, "");
  fireEvent.blur(input);
  click(buttonByName("Custom templates", dialog)!);

  // A blank field is a slip, not a request to erase the name.
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
});

test("Renaming a template updates its card in the panel", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();
  const input = await openDetail(dialog, "Q3 board review");

  await fill(input, "  Board   review FY26  ");
  fireEvent.blur(input);
  click(buttonByName("Custom templates", dialog)!);

  // Surrounding and repeated whitespace is collapsed before it is stored.
  await expect(
    within(dialog).findByText("Board review FY26"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();
});

test("Changing visibility updates the card's meta line", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();
  await openDetail(dialog, "Q3 board review");

  click(buttonByName("Change", dialog)!);
  const organization = await waitFor(() => {
    const option = queryAllByRoleFast("radio").find((candidate) => {
      return candidate.textContent?.startsWith("Organization");
    });
    if (!option) {
      throw new Error("Expected an Organization visibility option");
    }
    return option;
  });
  click(organization);
  click(buttonByName("Custom templates", dialog)!);

  await expect(
    within(dialog).findByText("Organization"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Private")).not.toBeInTheDocument();
});

test("Deleting a custom template removes it from the panel", async () => {
  let templates = [
    customTemplate(),
    customTemplate({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Renewal deck",
    }),
  ];
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(
      200,
      templates.map(({ pageUrls: _pageUrls, ...entry }) => {
        return entry;
      }),
    );
  });
  context.mocks.api(userTemplatesContract.delete, ({ params, respond }) => {
    templates = templates.filter((candidate) => {
      return candidate.id !== params.templateId;
    });
    return respond(204);
  });

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByText("Q3 board review");

  click(buttonByName("Actions for Q3 board review", dialog)!);
  await waitFor(() => {
    expect(menuItemByName("Delete")).toBeInTheDocument();
  });
  click(menuItemByName("Delete"));

  await waitFor(() => {
    expect(
      within(dialog).queryByText("Q3 board review"),
    ).not.toBeInTheDocument();
  });
  expect(within(dialog).getByText("Renewal deck")).toBeInTheDocument();
});

test("Uploading moves to Custom once the switch is on", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel();

  // The Presentation tab is the built-in templates alone: the tile that starts
  // an upload, and the decks a previous upload produced, belong to the catalog
  // this member can now open.
  click(tabByText("Presentation"));
  await waitFor(() => {
    expect(
      dialog.querySelector("[data-presentation-template-import]"),
    ).toBeNull();
  });

  click(tabByText("Custom"));
  await within(dialog).findByText("Q3 board review");
  expect(
    within(dialog).getByLabelText("Import your own deck"),
  ).toBeInTheDocument();
});

test("Uploading stays in Presentation while the switch is off", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel(false);

  click(tabByText("Presentation"));
  await waitFor(() => {
    expect(
      dialog.querySelector("[data-presentation-template-import]"),
    ).not.toBeNull();
  });
});
