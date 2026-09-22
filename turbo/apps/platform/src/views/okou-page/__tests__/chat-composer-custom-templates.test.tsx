import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import {
  userTemplatesContract,
  type UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  THREAD_ID,
  context,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";

/** What the Custom entry asks for, whatever the file turns out to be. */
const PROMPT = "Analyse this file and save it as a reusable template.";

/**
 * What the run is told on top of that request, and the member is not: which
 * guide reads the file — the Custom template dispatcher — and which catalog
 * the result belongs in.
 */
const GUIDANCE =
  "Analyse this file with the `extract-template` dispatcher in `okou-ai/okou-skills`: read `extract-template/SKILL.md` there, take the branch it routes this file to, and follow that branch. Publish with `okou user-template publish` and the `--kind` that branch produced, so it appears under Custom.";

function additionalInfo(message: UserMessageDocument): string[] {
  return message.parts.flatMap((part) => {
    return part.type === "additional_info" ? [part.text] : [];
  });
}

function customTemplate(
  overrides: Partial<UserTemplateDetail> = {},
): UserTemplateDetail {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Q3 board review",
    sourceFilename: "q3-board-final-v4.pptx",
    kind: "presentation",
    coverUrl: "https://example.test/cover.png",
    coverHasMorePages: true,
    pageCount: 18,
    visibility: "private",
    ownerUserId: "user_self",
    ownerDisplayName: "Dana Self",
    canManage: true,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    pageUrls: ["https://example.test/page-1.png"],
    sourceUrl: "https://example.test/source.pptx?signature=abc",
    previewAssets: [],
    ...overrides,
  };
}

function mockCustomTemplates(templates: readonly UserTemplateDetail[]): void {
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(
      200,
      templates.map(
        ({ pageUrls: _pageUrls, sourceUrl: _sourceUrl, ...entry }) => {
          return entry;
        },
      ),
    );
  });
}

/**
 * How one request finishes: a promise holds the response open until the test
 * releases it, `"fail"` answers 500, and nothing at all answers immediately.
 */
type RequestOutcome = Promise<void> | "fail" | undefined;

/**
 * List, detail, update and delete served from one mutable array, so a mutation is
 * observable the only way a user can observe it: by looking at the panel again.
 *
 * Each hook receives that request's 1-based number and chooses its outcome.
 * Holding a named request is what makes the editor's behaviour during a save
 * observable at all — the alternative is guessing at it with a sleep.
 */
function mockCustomTemplateStore(
  initial: readonly UserTemplateDetail[],
  outcomes: {
    readonly list?: (call: number) => RequestOutcome;
    readonly update?: (call: number) => RequestOutcome;
    readonly detail?: (call: number) => RequestOutcome;
    readonly delete?: (call: number) => RequestOutcome;
  } = {},
) {
  let templates = [...initial];
  let listCalls = 0;
  let detailCalls = 0;
  let updateCalls = 0;
  let deleteCalls = 0;
  const serverError = {
    error: {
      code: "INTERNAL_SERVER_ERROR" as const,
      message: "User template request failed",
    },
  };
  context.mocks.api(
    userTemplatesContract.list,
    async ({ respond, withSignal }) => {
      // Capture what this read saw before its response is delayed. A later
      // PATCH cannot retroactively change an already-running list or detail.
      const catalog = templates.map(
        ({ pageUrls: _pageUrls, sourceUrl: _sourceUrl, ...entry }) => {
          return entry;
        },
      );
      listCalls += 1;
      const outcome = outcomes.list?.(listCalls);
      if (outcome === "fail") {
        return respond(500, serverError);
      }
      if (outcome) {
        await withSignal(outcome);
      }
      return respond(200, catalog);
    },
  );
  context.mocks.api(
    userTemplatesContract.get,
    async ({ params, respond, withSignal }) => {
      const template = templates.find((candidate) => {
        return candidate.id === params.templateId;
      });
      if (!template) {
        throw new Error(`No template mocked for ${params.templateId}`);
      }
      detailCalls += 1;
      const outcome = outcomes.detail?.(detailCalls);
      if (outcome === "fail") {
        return respond(500, serverError);
      }
      if (outcome) {
        await withSignal(outcome);
      }
      return respond(200, template);
    },
  );
  context.mocks.api(
    userTemplatesContract.update,
    async ({ body, params, respond, withSignal }) => {
      updateCalls += 1;
      const outcome = outcomes.update?.(updateCalls);
      if (outcome === "fail") {
        return respond(500, serverError);
      }
      if (outcome) {
        await withSignal(outcome);
      }
      const index = templates.findIndex((candidate) => {
        return candidate.id === params.templateId;
      });
      const current = templates[index];
      if (!current) {
        throw new Error(`No template mocked for ${params.templateId}`);
      }
      const updated: UserTemplateDetail = {
        ...current,
        updatedAt: new Date(Date.parse(current.updatedAt) + 1000).toISOString(),
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.visibility === undefined
          ? {}
          : { visibility: body.visibility }),
      };
      templates[index] = updated;
      const {
        pageUrls: _pageUrls,
        sourceUrl: _sourceUrl,
        previewAssets: _previewAssets,
        ...summary
      } = updated;
      return respond(200, summary);
    },
  );
  context.mocks.api(
    userTemplatesContract.delete,
    async ({ params, respond, withSignal }) => {
      deleteCalls += 1;
      const outcome = outcomes.delete?.(deleteCalls);
      if (outcome === "fail") {
        return respond(500, serverError);
      }
      if (outcome) {
        await withSignal(outcome);
      }
      templates = templates.filter((template) => {
        return template.id !== params.templateId;
      });
      return respond(204);
    },
  );
  return {
    replace: (next: readonly UserTemplateDetail[]) => {
      templates = [...next];
    },
  };
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

async function openCustomPanel(enabled = true, chipCover = false) {
  const user = userEvent.setup({ delay: null });
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: enabled,
      // Off by default, as in production. The two tests that turn it on are
      // the ones asking which covers reach the chip once it draws any.
      [FeatureSwitchKey.ComposerTemplateChipCover]: chipCover,
    },
  });
  const dialog = await openTemplatePicker(user);
  return { user, dialog, capture };
}

test("The Custom category stays hidden while the switch is off", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel(false);

  // The seven format categories are untouched.
  expect(queryTabByText("Presentation")).toBeTruthy();
  expect(queryTabByText("Custom")).toBeUndefined();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();
});

test("The picker opens on Custom once the switch is on", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel();

  // Custom leads the nav for this member, so the picker lands there without a
  // click rather than on the first format below it.
  expect(tabByText("Custom")).toHaveAttribute("aria-selected", "true");
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
});

test("Custom opens and reopens on documents even when an image is newest", async () => {
  mockCustomTemplates([
    illustrationTemplate({ updatedAt: "2026-01-04T00:00:00Z" }),
    customTemplate({ updatedAt: "2026-01-03T00:00:00Z" }),
    documentTemplate(),
  ]);

  const { user, dialog } = await openCustomPanel();
  await within(dialog).findByText("Brand report");
  const filters = within(dialog).getByRole("group", {
    name: "Template categories",
  });
  expect(buttonByName("Document", filters)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(dialog).queryByText("Market day")).not.toBeInTheDocument();

  click(buttonByName("Image", filters)!);
  await within(dialog).findByText("Market day");
  click(buttonByName("Close", dialog)!);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  const reopened = await openTemplatePicker(user);
  await within(reopened).findByText("Brand report");
  const reopenedFilters = within(reopened).getByRole("group", {
    name: "Template categories",
  });
  expect(buttonByName("Document", reopenedFilters)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(reopened).queryByText("Market day")).not.toBeInTheDocument();
});

test("The picker keeps opening on Presentation while the switch is off", async () => {
  mockCustomTemplates([customTemplate()]);

  await openCustomPanel(false);

  expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
});

test("A named category still wins over the one the nav leads with", async () => {
  mockCustomTemplates([customTemplate()]);

  const { user } = await openCustomPanel();
  await user.click(tabByText("Presentation"));

  expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
  expect(tabByText("Custom")).toHaveAttribute("aria-selected", "false");
});

test("Keyboard navigation includes Custom across its category separator", async () => {
  mockCustomTemplates([customTemplate()]);

  const { user, dialog } = await openCustomPanel();
  await within(dialog).findByText("Q3 board review");
  await user.click(tabByText("Custom"));
  await user.keyboard("{ArrowDown}");
  expect(tabByText("Presentation")).toHaveFocus();
  expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Home}");
  const custom = tabByText("Custom");
  expect(custom).toHaveFocus();
  expect(custom).toHaveAttribute("aria-selected", "true");
  const panel = await within(dialog).findByRole("tabpanel", {
    name: "Custom",
  });
  expect(custom).toHaveAttribute("aria-controls", panel.id);
  expect(panel).toHaveAttribute("aria-labelledby", custom.id);
  await expect(
    within(panel).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
});

test("The switch decides whether the catalog is requested at all", async () => {
  let listed = 0;
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    listed += 1;
    return respond(200, []);
  });

  await openCustomPanel(false);

  // The composer resolves the selected-template chip against this catalog on
  // every render, for every member. Hiding the Custom tab is not enough — a
  // member without the feature must not have asked for it.
  expect(listed).toBe(0);
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
      ownerDisplayName: "Robin Ito",
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

test("A template published while the panel is open appears in it", async () => {
  // The analysis runs in a thread, so the publish reaches this member's
  // catalog while the picker they started it from is open in front of them.
  let templates: readonly UserTemplateDetail[] = [customTemplate()];
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(
      200,
      templates.map(
        ({ pageUrls: _pageUrls, sourceUrl: _sourceUrl, ...entry }) => {
          return entry;
        },
      ),
    );
  });

  const { dialog } = await openCustomPanel();
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();

  templates = [
    customTemplate({
      id: "33333333-3333-4333-8333-333333333333",
      title: "Party invitation",
      sourceFilename: "invitation.docx",
      kind: "document",
    }),
    ...templates,
  ];
  context.mocks.ably.trigger("presentationTemplatesChanged");

  await expect(
    within(dialog).findByText("Party invitation"),
  ).resolves.toBeInTheDocument();
});

test("A slow catalog refresh keeps browsing and search available", async () => {
  const refreshStarted = context.mocks.deferred<void>();
  const refresh = context.mocks.deferred<void>();
  let refreshing = false;
  const board = customTemplate();
  const renewal = customTemplate({
    id: "22222222-2222-4222-8222-222222222222",
    title: "Renewal deck",
    sourceFilename: "renewal.pptx",
  });
  const library = mockCustomTemplateStore([board, renewal], {
    list: () => {
      if (refreshing) {
        if (!refreshStarted.settled()) {
          refreshStarted.resolve();
        }
        return refresh.promise;
      }
      return undefined;
    },
  });

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText(board.title);
  await fill(within(dialog).getByLabelText("Search templates"), "board");
  await waitFor(() => {
    expect(within(dialog).queryByText(renewal.title)).not.toBeInTheDocument();
  });
  const scrollSurface = () => {
    const surface = within(dialog).getByRole("region", {
      name: "Custom templates",
    });
    return surface;
  };
  fireEvent.scroll(scrollSurface(), { target: { scrollTop: 240 } });

  library.replace([board, { ...renewal, title: "Renewal deck revised" }]);
  refreshing = true;
  await act(async () => {
    context.mocks.ably.trigger("presentationTemplatesChanged");
    await refreshStarted.promise;
  });

  expect(within(dialog).getByText(board.title)).toBeInTheDocument();
  expect(within(dialog).getByLabelText("Search templates")).toHaveValue(
    "board",
  );
  expect(within(dialog).getByLabelText("Search templates")).toHaveFocus();
  expect(scrollSurface().scrollTop).toBe(240);
  expect(
    buttonByName(`Preview ${board.title}`, dialog)?.querySelector("img"),
  ).toHaveAttribute("src", board.coverUrl);

  // Filtering is local even while the server is refreshing the catalog.
  await fill(within(dialog).getByLabelText("Search templates"), "renewal");
  await expect(
    within(dialog).findByText(renewal.title),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText(board.title)).not.toBeInTheDocument();

  refresh.resolve();
  await expect(
    within(dialog).findByText("Renewal deck revised"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByLabelText("Search templates")).toHaveValue(
    "renewal",
  );
  expect(scrollSurface().scrollTop).toBe(240);
});

test("A colleague withdrawing a shared template removes it from the catalog", async () => {
  const own = customTemplate();
  const shared = customTemplate({
    id: "22222222-2222-4222-8222-222222222222",
    title: "Partner QBR",
    visibility: "organization",
    ownerUserId: "user_colleague",
    canManage: false,
  });
  const library = mockCustomTemplateStore([own, shared]);

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText(shared.title);

  library.replace([{ ...own, title: "Updated board review" }]);
  context.mocks.ably.trigger("presentationTemplatesChanged", shared.id);

  await expect(
    within(dialog).findByText("Updated board review"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText(shared.title)).not.toBeInTheDocument();
});

test("A card carries who can see the template and nothing else about it", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await expect(
    within(dialog).findByText("Private"),
  ).resolves.toBeInTheDocument();
  // A grid is read by what tells its tiles apart, and the file a template was
  // compiled from says nothing about the one beside it. Both facts are still
  // on the detail column, which is where they are asked for.
  expect(within(dialog).queryByText("18 pages")).not.toBeInTheDocument();
  expect(
    within(dialog).queryByText("q3-board-final-v4.pptx"),
  ).not.toBeInTheDocument();
});

test("A colleague's template names its owner and offers no management", async () => {
  mockCustomTemplates([
    customTemplate({ title: "Mine" }),
    customTemplate({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Theirs",
      ownerUserId: "user_colleague",
      ownerDisplayName: "Robin Ito",
      canManage: false,
    }),
  ]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await expect(
    within(dialog).findByText("Theirs"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByText("Shared by Robin Ito")).toBeInTheDocument();
  // The identity-provider handle is what the row used to show in its place.
  expect(within(dialog).queryByText(/user_colleague/u)).not.toBeInTheDocument();
  expect(buttonByName("Actions for Theirs", dialog)).toBeUndefined();
  expect(buttonByName("Actions for Mine", dialog)).toBeTruthy();
});

test("An owner the provider cannot name still reads as a person", async () => {
  mockCustomTemplates([
    customTemplate({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Theirs",
      ownerUserId: "user_colleague",
      ownerDisplayName: null,
      canManage: false,
    }),
  ]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await expect(
    within(dialog).findByText("Theirs"),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).getByText("Shared by an organization member"),
  ).toBeInTheDocument();
  expect(within(dialog).queryByText(/user_colleague/u)).not.toBeInTheDocument();
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

test("An unsuccessful search keeps its controls and can be cleared", async () => {
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
  expect(within(dialog).getByLabelText("Search templates")).toBeInTheDocument();
  expect(
    within(dialog).getByRole("group", { name: "Template categories" }),
  ).toBeInTheDocument();
  click(buttonByName("Clear search", dialog)!);
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByLabelText("Search templates")).toHaveValue("");
});

test("Kind filters combine with search without an All option", async () => {
  mockCustomTemplates([
    customTemplate(),
    documentTemplate(),
    illustrationTemplate(),
  ]);

  const { dialog } = await openCustomPanel();
  const filters = await within(dialog).findByRole("group", {
    name: "Template categories",
  });

  click(buttonByName("Document", filters)!);
  await expect(
    within(dialog).findByText("Brand report"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();
  expect(within(dialog).queryByText("Market day")).not.toBeInTheDocument();

  click(buttonByName("Presentation", filters)!);
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Brand report")).not.toBeInTheDocument();

  click(buttonByName("Image", filters)!);
  await expect(
    within(dialog).findByText("Market day"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();

  const search = within(dialog).getByPlaceholderText("Search templates");
  await fill(search, "brand-report.docx");
  await expect(
    within(dialog).findByText("No matches"),
  ).resolves.toBeInTheDocument();
  expect(buttonByName("Image", filters)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  click(buttonByName("Document", filters)!);
  await expect(
    within(dialog).findByText("Brand report"),
  ).resolves.toBeInTheDocument();
  expect(search).toHaveValue("brand-report.docx");
  expect(within(dialog).queryByText("Market day")).not.toBeInTheDocument();

  await fill(search, "");
  await expect(
    within(dialog).findByText("Brand report"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Market day")).not.toBeInTheDocument();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();
  expect(buttonByName("All", filters)).toBeUndefined();
});

test.each(["click", "{Enter}", " "])(
  "An empty kind hides filters and Custom reopens the available catalog with %s",
  async (activation) => {
    mockCustomTemplates([customTemplate()]);
    const { user, dialog } = await openCustomPanel();
    const filters = await within(dialog).findByRole("group", {
      name: "Template categories",
    });
    click(buttonByName("Image", filters)!);
    await expect(
      within(dialog).findByText("No images yet"),
    ).resolves.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("Search templates"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("group", { name: "Template categories" }),
    ).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button", dialog).filter((button) => {
        return button.textContent?.trim() === "Import template";
      }),
    ).toHaveLength(1);
    const custom = tabByText("Custom");
    if (activation === "click") {
      click(custom);
    } else {
      custom.focus();
      await user.keyboard(activation);
    }
    await expect(
      within(dialog).findByText("Q3 board review"),
    ).resolves.toBeInTheDocument();
    const restoredFilters = within(dialog).getByRole("group", {
      name: "Template categories",
    });
    expect(buttonByName("Presentation", restoredFilters)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
);

test("An empty catalog leads with the upload entry instead of showing no matches", async () => {
  mockCustomTemplates([]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await expect(
    within(dialog).findByText(
      "Import a document, presentation or image to reuse its design.",
    ),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByLabelText("Import template")).toBeInTheDocument();
  expect(within(dialog).queryByText("No matches")).not.toBeInTheDocument();
});

test("An empty catalog offers no search box, because there is nothing to narrow", async () => {
  mockCustomTemplates([]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByLabelText("Import template");

  expect(
    within(dialog).queryByPlaceholderText("Search templates"),
  ).not.toBeInTheDocument();
});

test("Opening a deck shows its pages and management controls", async () => {
  mockCustomTemplates([customTemplate()]);
  context.mocks.api(userTemplatesContract.get, ({ respond }) => {
    return respond(200, customTemplate());
  });

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByText("Q3 board review");

  click(buttonByName("Preview Q3 board review", dialog)!);

  // A deck opens in the same dialog a document does, and draws the pages the
  // reverse run already rendered rather than its source file through a viewer.
  const page = await screen.findByAltText("Page 1");
  expect(page).toHaveAttribute("src", "https://example.test/page-1.png");
  const preview = previewDialogAround(page);
  // The preview is a dialog inside the picker, which is what lets the picker
  // step out of view rather than stay half-visible around a narrower panel.
  expect(dialog).toHaveAttribute("data-nested-dialog-open");
  expect(preview).not.toHaveAttribute("data-nested-dialog-open");
  expect(within(preview).getByLabelText("Rename template")).toBeInTheDocument();
  expect(buttonByName("Use this template", preview)).toBeTruthy();
  expect(
    within(preview).queryByTestId("custom-template-source-preview"),
  ).not.toBeInTheDocument();
});

test("Using a custom template sends the row id and nothing about its kind", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel(true, true);

  click(tabByText("Custom"));
  await within(dialog).findByText("Q3 board review");
  click(buttonByName("Use", dialog)!);

  // The picker closes and the composer carries the template. The chip is the
  // whole observable effect: without a `custom` branch in the attachment
  // resolver, Use resolves to nothing and the click is silently swallowed.
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  // The chip carries the template's own title. Before the attachment resolver
  // knew `custom`, Use resolved to nothing and this never appeared; before the
  // node guard knew it, rendering the chip threw.
  await expect(screen.findByText("Q3 board review")).resolves.toBeVisible();
  // A deck's cover reaches the chip, which is what makes the document case
  // below a difference rather than a chip that never draws covers at all.
  await waitFor(() => {
    expect(
      document.querySelector('img[src="https://example.test/cover.png"]'),
    ).not.toBeNull();
  });
});

test("A document's cover stays in the catalog and off the composer chip", async () => {
  mockCustomTemplateStore([
    documentTemplate({ coverUrl: DOCUMENT_COVER_URL, coverHasMorePages: true }),
  ]);

  const { dialog } = await openCustomPanel(true, true);
  click(tabByText("Custom"));
  await within(dialog).findByText("Brand report");
  // The same picture the tile is showing, to make the absence below about the
  // chip rather than about a template that has no cover.
  expect(within(dialog).getByTestId("document-cover-page")).toHaveAttribute(
    "src",
    DOCUMENT_COVER_URL,
  );
  click(buttonByName("Use", dialog)!);

  await expect(screen.findByText("Brand report")).resolves.toBeVisible();
  // The chip draws a cover into a twenty-pixel square, cropped from the
  // middle, where a page of prose resolves to flat grey. The file glyph says
  // more, so the page is not handed over.
  expect(document.querySelector(`img[src="${DOCUMENT_COVER_URL}"]`)).toBeNull();
});

const DOCUMENT_SOURCE_URL =
  "https://storage.example.test/private-artifacts/brand-report.docx?signature=abc";

function documentTemplate(
  overrides: Partial<UserTemplateDetail> = {},
): UserTemplateDetail {
  return customTemplate({
    id: "33333333-3333-4333-8333-333333333333",
    title: "Brand report",
    sourceFilename: "brand-report.docx",
    kind: "document",
    coverUrl: null,
    coverHasMorePages: false,
    pageCount: null,
    pageUrls: [],
    sourceUrl: DOCUMENT_SOURCE_URL,
    ...overrides,
  });
}

/** The preview dialog the picker opens over itself, found by what it renders. */
function previewDialogAround(inside: HTMLElement): HTMLElement {
  const preview = inside.closest<HTMLElement>('[role="dialog"]');
  if (!preview) {
    throw new Error("Source preview dialog not found");
  }
  return preview;
}

test("A document template with no cover is tiled by its format", async () => {
  const template = documentTemplate();
  mockCustomTemplates([template]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await expect(
    within(dialog).findByText("Brand report"),
  ).resolves.toBeInTheDocument();
  // Nothing was rendered for it, so the tile carries the format it was
  // compiled from rather than an empty frame.
  expect(within(dialog).getByText("DOCX")).toBeInTheDocument();
  expect(
    within(dialog).queryByTestId("document-cover-page"),
  ).not.toBeInTheDocument();
});

const DOCUMENT_COVER_URL =
  "https://storage.example.test/private-artifacts/brand-report-page-1.png?signature=abc";

test("A document template with a cover is tiled by its first page over a stack", async () => {
  mockCustomTemplates([
    documentTemplate({
      coverUrl: DOCUMENT_COVER_URL,
      coverHasMorePages: true,
    }),
  ]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  const page = await within(dialog).findByTestId("document-cover-page");
  expect(page).toHaveAttribute("src", DOCUMENT_COVER_URL);
  // The page was rendered, so the format glyph steps aside for it.
  expect(within(dialog).queryByText("DOCX")).not.toBeInTheDocument();
  // Two sheets for a source that continued, whether it continued for one more
  // page or three hundred: they carry no image, so there is nothing for a
  // third to add.
  expect(within(dialog).getAllByTestId("document-cover-sheet")).toHaveLength(2);
});

test("A single-page document is tiled by one sheet with nothing behind it", async () => {
  mockCustomTemplates([
    documentTemplate({
      title: "Party invitation",
      sourceFilename: "invitation.docx",
      coverUrl: DOCUMENT_COVER_URL,
      coverHasMorePages: false,
    }),
  ]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await within(dialog).findByTestId("document-cover-page");
  // A stack behind a one-page invitation would claim pages the file does not
  // have, so the tile draws what is there and stops.
  expect(within(dialog).queryAllByTestId("document-cover-sheet")).toHaveLength(
    0,
  );
});

test("Opening a Word template hands the source file to the Office viewer", async () => {
  mockCustomTemplateStore([documentTemplate()]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByText("Brand report");
  click(buttonByName("Preview Brand report", dialog)!);

  // The browser cannot draw a Word document, so the file goes to the viewer
  // that can — the same one an attached document already opens in.
  const frame = await screen.findByTitle("brand-report.docx preview");
  const viewerUrl = new URL(frame.getAttribute("src") ?? "");
  expect(`${viewerUrl.origin}${viewerUrl.pathname}`).toBe(
    "https://view.officeapps.live.com/op/embed.aspx",
  );
  expect(viewerUrl.searchParams.get("src")).toBe(DOCUMENT_SOURCE_URL);

  // The dialog carries the management column a deck shows, so what a member
  // can do to a template does not depend on its kind.
  const preview = previewDialogAround(frame);
  expect(within(preview).getByLabelText("Rename template")).toBeVisible();
  expect(buttonByName("Use this template", preview)).toBeTruthy();
  // The catalog stays mounted behind the dialog instead of being replaced by
  // it, which is what separates opening a document from opening a deck.
  expect(within(dialog).getByText("Brand report")).toBeInTheDocument();
});

test("A PDF template opens in the browser's own viewer", async () => {
  mockCustomTemplateStore([
    documentTemplate({
      title: "Annual report",
      sourceFilename: "annual-report.pdf",
    }),
  ]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByText("Annual report");
  click(buttonByName("Preview Annual report", dialog)!);

  // A PDF needs neither our viewer nor Microsoft's: the browser renders it
  // from the source URL, handed over unchanged.
  const frame = await screen.findByTitle("annual-report.pdf preview");
  expect(frame).toHaveAttribute("src", `${DOCUMENT_SOURCE_URL}#navpanes=0`);
});

const ILLUSTRATION_SOURCE_URL =
  "https://storage.example.test/private-artifacts/market-day.png?signature=abc";

function illustrationTemplate(
  overrides: Partial<UserTemplateDetail> = {},
): UserTemplateDetail {
  return customTemplate({
    id: "44444444-4444-4444-8444-444444444444",
    title: "Market day",
    sourceFilename: "market-day.png",
    kind: "illustration",
    // The source is the cover, so unlike a document this kind has one without
    // anything having been rendered for it.
    coverUrl: ILLUSTRATION_SOURCE_URL,
    coverHasMorePages: false,
    pageCount: null,
    pageUrls: [],
    sourceUrl: ILLUSTRATION_SOURCE_URL,
    ...overrides,
  });
}

test("An illustration template is tiled by the picture it was reversed from", async () => {
  mockCustomTemplates([illustrationTemplate()]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await within(dialog).findByText("Market day");
  // A document with no cover falls back to a format badge. An illustration
  // never reaches that branch: its source is already a picture.
  expect(within(dialog).queryByText("PNG")).not.toBeInTheDocument();
  const cover = buttonByName("Preview Market day", dialog)?.querySelector(
    "img",
  );
  expect(cover).toHaveAttribute("src", ILLUSTRATION_SOURCE_URL);
});

test("Opening an illustration template shows the source picture itself", async () => {
  mockCustomTemplateStore([illustrationTemplate()]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByText("Market day");
  click(buttonByName("Preview Market day", dialog)!);

  // No viewer and no iframe: the browser draws this source, so it is drawn.
  const picture = await screen.findByTestId("custom-template-source-preview");
  expect(picture.tagName).toBe("IMG");
  expect(picture).toHaveAttribute("src", ILLUSTRATION_SOURCE_URL);

  // The same management column a document's dialog carries, and the catalog
  // still mounted behind it.
  const preview = previewDialogAround(picture);
  expect(buttonByName("Use this template", preview)).toBeTruthy();
  expect(within(dialog).getByText("Market day")).toBeInTheDocument();
});

test("A template whose detail will not load can be asked for again", async () => {
  let unavailable = true;
  mockCustomTemplateStore([customTemplate()], {
    detail: () => {
      return unavailable ? "fail" : undefined;
    },
  });

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByText("Q3 board review");
  click(buttonByName("Preview Q3 board review", dialog)!);

  // A detail that will not load says so and offers the way out. Without this
  // the dialog keeps its spinner for as long as it stays open, which is the
  // defect: nothing tells the member the request is never coming back.
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't load templates.");
  const preview = previewDialogAround(alert);

  unavailable = false;
  click(buttonByName("Retry", preview)!);

  // Asking again is the same request, so the template arrives on the surface
  // the failure was shown on rather than in a second dialog.
  const page = await screen.findByAltText("Page 1");
  expect(previewDialogAround(page)).toBe(preview);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

async function openDetail(
  dialog: HTMLElement,
  title: string,
): Promise<HTMLElement> {
  click(tabByText("Custom"));
  await within(dialog).findByText(title);
  click(buttonByName(`Preview ${title}`, dialog)!);
  // The preview dialog is portaled out of the picker, so the editor is found
  // on the document rather than inside the panel that opened it.
  return screen.findByLabelText("Rename template");
}

/** Leave the open template, which is what the dialog's breadcrumb does. */
function closeDetail(): void {
  click(buttonByName("Custom templates")!);
}

test("Clearing the title and leaving the field keeps the template named", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();
  const input = await openDetail(dialog, "Q3 board review");

  await fill(input, "");
  fireEvent.blur(input);
  closeDetail();

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
  closeDetail();

  // Surrounding and repeated whitespace is collapsed before it is stored.
  await expect(
    within(dialog).findByText("Board review FY26"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();
});

function renameField(): HTMLElement {
  return screen.getByLabelText("Rename template");
}

async function shareWithOrganization(): Promise<void> {
  click(buttonByName("Change")!);
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
}

test("A second rename waits for the one already sent", async () => {
  const stored = context.mocks.deferred<void>();
  mockCustomTemplateStore([customTemplate()], {
    update: (call) => {
      return call === 1 ? stored.promise : undefined;
    },
  });

  const { dialog } = await openCustomPanel();
  const input = await openDetail(dialog, "Q3 board review");

  await fill(input, "Board review FY26");
  fireEvent.blur(input);

  // Nothing here promises two renames arrive in the order they were typed, so
  // the field stays closed rather than letting the member send a second one.
  await waitFor(() => {
    expect(renameField()).toBeDisabled();
  });

  stored.resolve();

  // It reopens on the stored name, not on the one that was typed: the member
  // is editing what the server now holds.
  await waitFor(() => {
    expect(renameField()).toBeEnabled();
  });
  expect(renameField()).toHaveValue("Board review FY26");

  await fill(renameField(), "Board review FY27");
  fireEvent.blur(renameField());
  closeDetail();

  // The later edit is the one that survives — the defect was the earlier one
  // landing last and taking the name back.
  await expect(
    within(dialog).findByText("Board review FY27"),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).queryByText("Board review FY26"),
  ).not.toBeInTheDocument();
});

test("Confirmed edits finish before readback and survive an older catalog response", async () => {
  const catalogStarted = context.mocks.deferred<void>();
  const catalogReadback = context.mocks.deferred<void>();
  const detailReadback = context.mocks.deferred<void>();
  let refreshing = false;
  const board = customTemplate();
  const renewal = customTemplate({
    id: "22222222-2222-4222-8222-222222222222",
    title: "Renewal deck",
  });
  const library = mockCustomTemplateStore([board, renewal], {
    list: () => {
      if (refreshing) {
        if (!catalogStarted.settled()) {
          catalogStarted.resolve();
        }
        return catalogReadback.promise;
      }
      return undefined;
    },
    detail: () => {
      return refreshing ? detailReadback.promise : undefined;
    },
  });

  const { dialog } = await openCustomPanel();
  await openDetail(dialog, board.title);

  // This external update began before either local edit. Its response carries
  // the old title and visibility, even though PATCH will confirm newer values.
  // The re-rendered page is what makes its arrival observable.
  const refreshedPageUrl = "https://example.test/page-1-refreshed.png";
  const beforeEdits = {
    ...board,
    pageUrls: [refreshedPageUrl],
    updatedAt: "2026-01-02T00:00:01.000Z",
  };
  library.replace([
    beforeEdits,
    { ...renewal, title: "External catalog update" },
  ]);
  refreshing = true;
  await act(async () => {
    context.mocks.ably.trigger("presentationTemplatesChanged");
    await catalogStarted.promise;
  });

  await fill(renameField(), "  Board   review FY26  ");
  fireEvent.blur(renameField());

  await expect(
    within(dialog).findByText("Board review FY26"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(renameField()).toBeEnabled();
  });
  expect(renameField()).toHaveValue("Board review FY26");

  await shareWithOrganization();
  await expect(
    screen.findByText("Anyone in this organization can use it"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByText("Organization")).toBeInTheDocument();
  expect(screen.getByAltText("Page 1")).toHaveAttribute(
    "src",
    board.pageUrls[0],
  );

  catalogReadback.resolve();
  // The unrelated row proves the old catalog response has reached the page.
  await within(dialog).findByText("External catalog update");
  expect(within(dialog).getByText("Board review FY26")).toBeInTheDocument();
  expect(within(dialog).queryByText(board.title)).not.toBeInTheDocument();
  expect(within(dialog).getByText("Organization")).toBeInTheDocument();
  expect(within(dialog).getByText("Private")).toBeInTheDocument();
  expect(renameField()).toHaveValue("Board review FY26");
  expect(renameField()).toBeEnabled();
  expect(
    screen.getByText("Anyone in this organization can use it"),
  ).toBeInTheDocument();

  detailReadback.resolve();
  await waitFor(() => {
    expect(screen.getByAltText("Page 1")).toHaveAttribute(
      "src",
      refreshedPageUrl,
    );
  });
  expect(renameField()).toHaveValue("Board review FY26");
  expect(
    screen.getByText("Anyone in this organization can use it"),
  ).toBeInTheDocument();

  // A later edit from another tab must still supersede our confirmed edits.
  library.replace([
    {
      ...beforeEdits,
      title: "Latest board review",
      visibility: "private",
      updatedAt: "2026-01-02T00:00:04.000Z",
    },
    renewal,
  ]);
  refreshing = false;
  context.mocks.ably.trigger("presentationTemplatesChanged", board.id);
  await within(dialog).findByText("Latest board review");
  await screen.findByText("Only you can see and use it");
  expect(renameField()).toHaveValue("Latest board review");
});

test("A rename left behind by going back still reaches the list", async () => {
  const stored = context.mocks.deferred<void>();
  mockCustomTemplateStore([customTemplate()], {
    update: (call) => {
      return call === 1 ? stored.promise : undefined;
    },
  });

  const { dialog } = await openCustomPanel();
  const input = await openDetail(dialog, "Q3 board review");

  await fill(input, "Board review FY26");
  fireEvent.blur(input);
  closeDetail();

  await within(dialog).findByText("Q3 board review");
  // Leaving the detail does not retract a rename the member already committed
  // by blurring, so the card has to catch up when the server answers.
  stored.resolve();

  await expect(
    within(dialog).findByText("Board review FY26"),
  ).resolves.toBeInTheDocument();
});

test("A rejected rename keeps the typed name for another attempt", async () => {
  mockCustomTemplateStore([customTemplate()], {
    update: (call) => {
      return call === 1 ? "fail" : undefined;
    },
  });

  const { dialog } = await openCustomPanel();
  const input = await openDetail(dialog, "Q3 board review");

  await fill(input, "Board review FY26");
  fireEvent.blur(input);

  await expect(
    screen.findByText("Couldn't rename the template."),
  ).resolves.toBeInTheDocument();
  // The name the server refused is still in the field: it is the member's
  // work, and throwing it away would make them type it a second time.
  expect(renameField()).toBeEnabled();
  expect(renameField()).toHaveValue("Board review FY26");

  fireEvent.blur(renameField());
  closeDetail();

  await expect(
    within(dialog).findByText("Board review FY26"),
  ).resolves.toBeInTheDocument();
});

test("Changing visibility updates the card's meta line", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();
  await openDetail(dialog, "Q3 board review");

  await shareWithOrganization();
  closeDetail();

  await expect(
    within(dialog).findByText("Organization"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Private")).not.toBeInTheDocument();
});

test("A confirmed deletion removes only its card while an older catalog is pending", async () => {
  const refreshStarted = context.mocks.deferred<void>();
  const refresh = context.mocks.deferred<void>();
  const deleted = context.mocks.deferred<void>();
  let refreshing = false;
  const board = customTemplate();
  const renewal = customTemplate({
    id: "22222222-2222-4222-8222-222222222222",
    title: "Renewal deck",
  });
  mockCustomTemplateStore([board, renewal], {
    delete: () => {
      return deleted.promise;
    },
  });
  let catalog = [board, renewal];
  context.mocks.api(
    userTemplatesContract.list,
    async ({ respond, withSignal }) => {
      const snapshot = catalog.map(
        ({ pageUrls: _pageUrls, sourceUrl: _sourceUrl, ...entry }) => {
          return entry;
        },
      );
      if (refreshing) {
        if (!refreshStarted.settled()) {
          refreshStarted.resolve();
        }
        await withSignal(refresh.promise);
      }
      return respond(200, snapshot);
    },
  );

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText(board.title);

  catalog = [
    board,
    renewal,
    customTemplate({
      id: "33333333-3333-4333-8333-333333333333",
      title: "Published during deletion",
    }),
  ];
  refreshing = true;
  await act(async () => {
    context.mocks.ably.trigger("presentationTemplatesChanged");
    await refreshStarted.promise;
  });

  click(buttonByName("Actions for Q3 board review", dialog)!);
  await waitFor(() => {
    expect(menuItemByName("Delete")).toBeInTheDocument();
  });
  click(menuItemByName("Delete"));
  expect(within(dialog).getByText(board.title)).toBeInTheDocument();
  expect(within(dialog).getByText(renewal.title)).toBeInTheDocument();

  deleted.resolve();
  await waitFor(() => {
    expect(within(dialog).getByText(renewal.title)).toBeInTheDocument();
    expect(within(dialog).queryByText(board.title)).not.toBeInTheDocument();
  });
  expect(within(dialog).getByLabelText("Search templates")).toBeInTheDocument();

  refresh.resolve();
  await within(dialog).findByText("Published during deletion");
  expect(within(dialog).queryByText(board.title)).not.toBeInTheDocument();
  expect(within(dialog).getByText(renewal.title)).toBeInTheDocument();
});

test.each(["visibility change", "deletion"] as const)(
  "A failed %s keeps the template and reports the error",
  async (operation) => {
    mockCustomTemplateStore([customTemplate()], {
      update: () => {
        return operation === "visibility change" ? "fail" : undefined;
      },
      delete: () => {
        return operation === "deletion" ? "fail" : undefined;
      },
    });

    const { dialog } = await openCustomPanel();
    await openDetail(dialog, "Q3 board review");

    if (operation === "visibility change") {
      await shareWithOrganization();
    } else {
      click(buttonByName("Delete")!);
    }

    await expect(
      screen.findByText("User template request failed"),
    ).resolves.toBeInTheDocument();
    expect(renameField()).toHaveValue("Q3 board review");
    expect(screen.getByText("Only you can see and use it")).toBeInTheDocument();
    expect(within(dialog).getByText("Q3 board review")).toBeInTheDocument();
    expect(within(dialog).getByText("Private")).toBeInTheDocument();
  },
);

test("Uploading moves to Custom once the switch is on", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel();

  // The built-in Presentation tab delegates importing to Custom.
  click(tabByText("Presentation"));
  await waitFor(() => {
    expect(
      dialog.querySelector("[data-presentation-template-import]"),
    ).toBeNull();
  });

  click(tabByText("Custom"));
  await within(dialog).findByText("Q3 board review");
  expect(within(dialog).getByLabelText("Import template")).toBeInTheDocument();
});

test("One entry takes every kind of source a template can be made from", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel();

  click(tabByText("Custom"));
  const entry = await within(dialog).findByLabelText("Import template");
  // The active category never narrows the files accepted by the import action.
  expect(entry.getAttribute("accept")).toBe(
    ".pptx,.ppt,.pdf,.docx,.doc,.png,.jpg,.jpeg,.webp,.bmp",
  );
});

test("A document can be imported while browsing images", async () => {
  mockCustomTemplates([illustrationTemplate()]);
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000011",
    filename: "brand-report.docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 5,
    url: "https://cdn.example.test/brand-report.docx",
  });

  const { user, dialog, capture } = await openCustomPanel();

  click(tabByText("Custom"));
  await user.upload(
    await within(dialog).findByLabelText("Import template"),
    new File(["docx"], "brand-report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );

  await waitFor(() => {
    expect(capture.runPrompts).toHaveLength(1);
  });
  // The `extract-template` guide decides whether the file is a deck or a
  // document; repeating that here would give the run two answers that can
  // disagree. What the member reads is the request they made, one sentence
  // long whatever the file turns out to be.
  expect(capture.runPrompts[0]).toBe(PROMPT);
  // The catalog still has to be said, because the guide's presentation branch
  // names the other one — so it is said where only the run reads it, along
  // with the `--kind` a document needs to avoid the flag's presentation
  // default, and the repository that tells the dispatcher apart from the
  // registry's presentation-only copy.
  expect(additionalInfo(capture.sentMessages[0]!)).toStrictEqual([GUIDANCE]);
});

test("A deck from the same entry is sent the same message", async () => {
  mockCustomTemplates([]);
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000012",
    filename: "brand-system.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 5,
    url: "https://cdn.example.test/brand-system.pptx",
  });

  const { user, dialog, capture } = await openCustomPanel();

  click(tabByText("Custom"));
  await user.upload(
    await within(dialog).findByLabelText("Import template"),
    new File(["pptx"], "brand-system.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
  );

  await waitFor(() => {
    expect(capture.runPrompts).toHaveLength(1);
  });
  expect(capture.runPrompts[0]).toBe(PROMPT);
  expect(additionalInfo(capture.sentMessages[0]!)).toStrictEqual([GUIDANCE]);
});

test("Choosing a source leaves the picker for the thread it starts", async () => {
  mockCustomTemplates([customTemplate()]);
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000013",
    filename: "brand-report.docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 5,
    url: "https://cdn.example.test/brand-report.docx",
  });
  const user = userEvent.setup({ delay: null });
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: true },
  });
  const dialog = await openTemplatePicker(user);

  click(tabByText("Custom"));
  await user.upload(
    await within(dialog).findByLabelText("Import template"),
    new File(["docx"], "brand-report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );

  await waitFor(() => {
    expect(capture.runPrompts).toHaveLength(1);
  });
  // The import sends a message, and the thread it sends into is the one the
  // member was just handed. A picker left open covers the run they were sent
  // to watch — and from an existing chat nothing else takes it away.
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
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
