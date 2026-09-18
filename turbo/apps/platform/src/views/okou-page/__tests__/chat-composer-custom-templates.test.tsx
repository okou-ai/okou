import {
  userTemplatesContract,
  type UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

/** What the Custom entry sends, whatever the file turns out to be. */
const PROMPT =
  "Analyse this file with the `reverse-template` skill and save it as a reusable template. Publish the result with `okou user-template publish` so it appears under Custom — not with `okou presentation-template publish`, which the guide's presentation branch names for the other catalog.";

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
 * List, detail and update served from one mutable array, so a mutation is
 * observable the only way a user can observe it: by looking at the panel again.
 *
 * Each hook receives that request's 1-based number and chooses its outcome.
 * Holding a named request is what makes the editor's behaviour during a save
 * observable at all — the alternative is guessing at it with a sleep.
 */
function mockCustomTemplateStore(
  initial: readonly UserTemplateDetail[],
  outcomes: {
    readonly update?: (call: number) => RequestOutcome;
    readonly detail?: (call: number) => RequestOutcome;
  } = {},
): void {
  const templates = [...initial];
  let detailCalls = 0;
  let updateCalls = 0;
  const serverError = {
    error: {
      code: "INTERNAL_SERVER_ERROR" as const,
      message: "User template update failed",
    },
  };
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
  context.mocks.api(
    userTemplatesContract.get,
    async ({ params, respond, withSignal }) => {
      detailCalls += 1;
      const outcome = outcomes.detail?.(detailCalls);
      if (outcome === "fail") {
        return respond(500, serverError);
      }
      if (outcome) {
        await withSignal(outcome);
      }
      const template = templates.find((candidate) => {
        return candidate.id === params.templateId;
      });
      if (!template) {
        throw new Error(`No template mocked for ${params.templateId}`);
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
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: enabled },
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

test("An empty catalog leads with the upload entry instead of showing no matches", async () => {
  mockCustomTemplates([]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));

  await expect(
    within(dialog).findByText(
      "Okou turns your file's design into a template you can reuse.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).getByLabelText("Import your own file"),
  ).toBeInTheDocument();
  expect(within(dialog).queryByText("No matches")).not.toBeInTheDocument();
});

test("An empty catalog offers no search box, because there is nothing to narrow", async () => {
  mockCustomTemplates([]);

  const { dialog } = await openCustomPanel();
  click(tabByText("Custom"));
  await within(dialog).findByLabelText("Import your own file");

  expect(
    within(dialog).queryByPlaceholderText("Search templates"),
  ).not.toBeInTheDocument();
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
  expect(buttonByName("Use this template", dialog)).toBeTruthy();
});

test("Using a custom template sends the row id and nothing about its kind", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();

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
    pageCount: null,
    pageUrls: [],
    sourceUrl: DOCUMENT_SOURCE_URL,
    ...overrides,
  });
}

/** The preview dialog the picker opens over itself, found by what it renders. */
function previewDialogAround(frame: HTMLElement): HTMLElement {
  const preview = frame.closest<HTMLElement>('[role="dialog"]');
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

  // The dialog carries the management column the panel shows for a deck, so
  // what a member can do to a template does not depend on its kind.
  const preview = previewDialogAround(frame);
  expect(within(preview).getByText("From brand-report.docx")).toBeVisible();
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

function renameField(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByLabelText("Rename template");
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
    expect(renameField(dialog)).toBeDisabled();
  });

  stored.resolve();

  // It reopens on the stored name, not on the one that was typed: the member
  // is editing what the server now holds.
  await waitFor(() => {
    expect(renameField(dialog)).toBeEnabled();
  });
  expect(renameField(dialog)).toHaveValue("Board review FY26");

  await fill(renameField(dialog), "Board review FY27");
  fireEvent.blur(renameField(dialog));
  click(buttonByName("Custom templates", dialog)!);

  // The later edit is the one that survives — the defect was the earlier one
  // landing last and taking the name back.
  await expect(
    within(dialog).findByText("Board review FY27"),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).queryByText("Board review FY26"),
  ).not.toBeInTheDocument();
});

test("The editor is not taken away by the readback its own save causes", async () => {
  const readback = context.mocks.deferred<void>();
  let detailRequests = 0;
  mockCustomTemplateStore([customTemplate()], {
    detail: (call) => {
      detailRequests = call;
      // The first request opens the editor; the second is the readback the
      // rename invalidated.
      return call === 2 ? readback.promise : undefined;
    },
  });

  const { dialog } = await openCustomPanel();
  const input = await openDetail(dialog, "Q3 board review");

  await fill(input, "Board review FY26");
  fireEvent.blur(input);

  await waitFor(() => {
    expect(detailRequests).toBe(2);
  });
  // A query refreshing underneath the editor is not a reason to remove the
  // field the member is waiting to get back. This is the element they were
  // typing into, not a replacement mounted in its place.
  expect(input).toBeInTheDocument();
  expect(input).toBeDisabled();

  readback.resolve();

  await waitFor(() => {
    expect(renameField(dialog)).toBeEnabled();
  });
  expect(renameField(dialog)).toHaveValue("Board review FY26");
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
  click(buttonByName("Custom templates", dialog)!);

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
    within(dialog).findByText("Couldn't rename the template."),
  ).resolves.toBeInTheDocument();
  // The name the server refused is still in the field: it is the member's
  // work, and throwing it away would make them type it a second time.
  expect(renameField(dialog)).toBeEnabled();
  expect(renameField(dialog)).toHaveValue("Board review FY26");

  fireEvent.blur(renameField(dialog));
  click(buttonByName("Custom templates", dialog)!);

  await expect(
    within(dialog).findByText("Board review FY26"),
  ).resolves.toBeInTheDocument();
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
      templates.map(
        ({ pageUrls: _pageUrls, sourceUrl: _sourceUrl, ...entry }) => {
          return entry;
        },
      ),
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
    within(dialog).getByLabelText("Import your own file"),
  ).toBeInTheDocument();
});

test("One entry takes every kind of source a template can be made from", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel();

  click(tabByText("Custom"));
  const entry = await within(dialog).findByLabelText("Import your own file");
  // Both kinds go through this one input. A separate tile per kind would ask
  // the user to classify their own file before the analysis has read it.
  expect(entry.getAttribute("accept")).toBe(".pptx,.ppt,.pdf,.docx,.doc");
});

test("Every source is sent with one message that lets the guide sort it", async () => {
  mockCustomTemplates([]);
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
    await within(dialog).findByLabelText("Import your own file"),
    new File(["docx"], "brand-report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );

  await waitFor(() => {
    expect(capture.runPrompts).toHaveLength(1);
  });
  // The `reverse-template` guide decides whether the file is a deck or a
  // document; repeating that here would give the run two answers that can
  // disagree. What this message does carry is the catalog, because the guide's
  // presentation branch names the other one.
  expect(capture.runPrompts[0]).toBe(PROMPT);
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
    await within(dialog).findByLabelText("Import your own file"),
    new File(["pptx"], "brand-system.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
  );

  await waitFor(() => {
    expect(capture.runPrompts).toHaveLength(1);
  });
  expect(capture.runPrompts[0]).toBe(PROMPT);
});

test("A source no kind is made from is refused before it is uploaded", async () => {
  mockCustomTemplates([]);
  const { dialog, capture } = await openCustomPanel();

  click(tabByText("Custom"));
  const entry = await within(dialog).findByLabelText("Import your own file");
  // Fired rather than uploaded through userEvent on purpose: `accept` is a
  // filter the browser offers, not one it enforces, so the refusal has to hold
  // for a file that reaches the input anyway.
  fireEvent.change(entry, {
    target: {
      files: [
        new File(["sheet"], "figures.xlsx", {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      ],
    },
  });

  await expect(
    screen.findByText(
      "Choose a .pptx, .ppt, .pdf, .docx, .doc file to make a template.",
    ),
  ).resolves.toBeVisible();
  // Refused before the bytes are spent, not after a run has already started on
  // a file that cannot become a template.
  expect(capture.runPrompts).toStrictEqual([]);
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
