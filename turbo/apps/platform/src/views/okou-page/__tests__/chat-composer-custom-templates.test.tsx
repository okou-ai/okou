import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
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
import { createDeferredPromise } from "../../../signals/utils.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  openTemplatePicker,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

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

/** `"fail"` answers 500; nothing at all answers immediately. */
type RequestOutcome = "fail" | undefined;

/**
 * List, detail, update and delete served from one mutable array, so a mutation is
 * observable the only way a user can observe it: by looking at the panel again.
 */
function mockCustomTemplateStore(
  initial: readonly UserTemplateDetail[],
  outcomes: {
    readonly update?: () => RequestOutcome;
    readonly delete?: () => RequestOutcome;
  } = {},
) {
  let templates = [...initial];
  const serverError = {
    error: {
      code: "INTERNAL_SERVER_ERROR" as const,
      message: "User template request failed",
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
      if (outcomes.update?.() === "fail") {
        return respond(500, serverError);
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
  context.mocks.api(userTemplatesContract.delete, ({ params, respond }) => {
    if (outcomes.delete?.() === "fail") {
      return respond(500, serverError);
    }
    templates = templates.filter((template) => {
      return template.id !== params.templateId;
    });
    return respond(204);
  });
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

async function openCustomPanel(
  enabled = true,
  category: "Presentation" | "Document" | "Image" = "Presentation",
) {
  const user = userEvent.setup({ delay: null });
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: enabled,
    },
  });
  const dialog = await openTemplatePicker(user);
  if (category !== "Presentation") {
    click(tabByText(category));
  }
  return { user, dialog, capture };
}

test("The switch preserves the ordinary Presentation catalog", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel(false);

  expect(queryTabByText("Presentation")).toBeTruthy();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();
});

test("The picker opens Presentation with separate Custom and Built-in sections", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel();

  expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
  expect(
    within(dialog).getByRole("region", { name: "Custom" }),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole("region", { name: "Built-in" }),
  ).toBeInTheDocument();
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
});

test("The switch decides whether the catalog is requested at all", async () => {
  let listed = 0;
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    listed += 1;
    return respond(200, []);
  });

  await openCustomPanel(false);

  // Hiding the Custom tab is not enough — a member without the feature must
  // not have asked for the catalog at all.
  expect(listed).toBe(0);
});

test("The Custom section lists owned and shared templates of the selected type", async () => {
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
  click(tabByText("Presentation"));

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
      sourceFilename: "invitation.pptx",
      kind: "presentation",
    }),
    ...templates,
  ];
  context.mocks.ably.trigger("presentationTemplatesChanged");

  await expect(
    within(dialog).findByText("Party invitation"),
  ).resolves.toBeInTheDocument();
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
  click(tabByText("Presentation"));

  await expect(
    within(dialog).findByText("Theirs"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByText("Shared by Robin Ito")).toBeInTheDocument();
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
  click(tabByText("Presentation"));
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

test("Content categories scope custom templates and reset their search", async () => {
  mockCustomTemplates([
    customTemplate(),
    documentTemplate(),
    illustrationTemplate(),
  ]);
  const { dialog } = await openCustomPanel();
  await within(dialog).findByText("Q3 board review");
  click(tabByText("Document"));
  await expect(
    within(dialog).findByText("Brand report"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();
  click(tabByText("Image"));
  await expect(
    within(dialog).findByText("Market day"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Brand report")).not.toBeInTheDocument();
  await fill(
    within(dialog).getByPlaceholderText("Search templates"),
    "brand-report.docx",
  );
  await expect(
    within(dialog).findByText("No matches"),
  ).resolves.toBeInTheDocument();
  click(tabByText("Document"));
  await expect(
    within(dialog).findByText("Brand report"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByPlaceholderText("Search templates")).toHaveValue(
    "",
  );
});

test("Every category names itself above its templates", async () => {
  mockCustomTemplates([]);
  const { dialog } = await openCustomPanel();
  for (const category of [
    "Presentation",
    "Document",
    "Website",
    "Image",
    "Workflow",
  ]) {
    click(tabByText(category));
    expect(
      within(dialog).getByRole("heading", { name: category, level: 2 }),
    ).toBeInTheDocument();
  }
});

test("An empty Custom section keeps the import tile and built-in styles usable", async () => {
  mockCustomTemplates([customTemplate()]);
  const { dialog } = await openCustomPanel();
  await within(dialog).findByText("Q3 board review");
  click(tabByText("Image"));
  const custom = within(dialog).getByRole("region", { name: "Custom" });
  await expect(
    within(custom).findByLabelText("Import your own"),
  ).resolves.toHaveAttribute("accept", ".png,.jpg,.jpeg,.webp,.bmp");
  expect(
    within(dialog).getByRole("region", { name: "Built-in" }),
  ).toBeInTheDocument();
  expect(tabByText("Image")).toHaveAttribute("aria-selected", "true");
  click(tabByText("Presentation"));
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
});

test("Returning to a type retains the loaded custom catalog", async () => {
  // Once the member has left Presentation, any further catalog request stays
  // unanswered for the rest of the test, as on a slow connection.
  const slowNetwork = createDeferredPromise<void>(context.signal);
  let answerCatalog = true;
  context.mocks.api(userTemplatesContract.list, async ({ respond }) => {
    if (!answerCatalog) {
      await slowNetwork.promise;
    }
    const {
      pageUrls: _pageUrls,
      sourceUrl: _sourceUrl,
      ...entry
    } = customTemplate();
    return respond(200, [entry]);
  });

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText("Q3 board review");

  answerCatalog = false;
  click(tabByText("Website"));
  await waitFor(() => {
    expect(within(dialog).queryByText("Q3 board review")).toBeNull();
  });
  click(tabByText("Presentation"));

  // Reloading on every return blanked the pane until the request answered.
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByLabelText("Search templates")).toBeInTheDocument();
});

test("An empty custom catalog offers its import tile", async () => {
  mockCustomTemplates([]);
  const { dialog } = await openCustomPanel();
  const custom = within(dialog).getByRole("region", { name: "Custom" });
  await expect(
    within(custom).findByLabelText("Import your own deck"),
  ).resolves.toHaveAttribute("accept", ".pptx,.ppt,.pdf");
  expect(
    within(dialog).getByRole("region", { name: "Built-in" }),
  ).toBeInTheDocument();
});

test("A custom deck steps through its pages on the stage", async () => {
  const deck = customTemplate({
    pageUrls: [
      "https://example.test/page-1.png",
      "https://example.test/page-2.png",
    ],
  });
  mockCustomTemplates([deck]);
  context.mocks.api(userTemplatesContract.get, ({ respond }) => {
    return respond(200, deck);
  });

  const { dialog } = await openCustomPanel();
  click(tabByText("Presentation"));
  await within(dialog).findByText("Q3 board review");
  click(buttonByName("Preview Q3 board review", dialog)!);

  const preview = previewDialogAround(await screen.findByAltText("Page 1"));
  expect(within(preview).getByText("1 / 2")).toBeInTheDocument();
  expect(within(preview).getByText("2 slides")).toBeInTheDocument();

  click(buttonByName("Preview slide 2", preview)!);

  expect(within(preview).getByAltText("Page 2")).toHaveAttribute(
    "src",
    "https://example.test/page-2.png",
  );
  expect(within(preview).getByText("2 / 2")).toBeInTheDocument();
  expect(buttonByName("Preview next slide", preview)).toBeDisabled();
});

test("A template shared with you opens without the owner's controls", async () => {
  const shared = customTemplate({
    canManage: false,
    visibility: "organization",
    ownerDisplayName: "Riley Park",
  });
  mockCustomTemplates([shared]);
  context.mocks.api(userTemplatesContract.get, ({ respond }) => {
    return respond(200, shared);
  });

  const { dialog } = await openCustomPanel();
  click(tabByText("Presentation"));
  await within(dialog).findByText("Q3 board review");
  click(buttonByName("Preview Q3 board review", dialog)!);

  const preview = previewDialogAround(await screen.findByAltText("Page 1"));
  expect(within(preview).getByText("Shared by Riley Park")).toBeInTheDocument();
  expect(
    within(preview).queryByLabelText("Rename template"),
  ).not.toBeInTheDocument();
  expect(
    within(preview).queryByText("Change template visibility"),
  ).not.toBeInTheDocument();
  expect(buttonByName("Delete", preview)).toBeUndefined();
  expect(buttonByName("Use this template", preview)).toBeTruthy();
});

test("Opening a deck shows its pages and management controls", async () => {
  mockCustomTemplates([customTemplate()]);
  context.mocks.api(userTemplatesContract.get, ({ respond }) => {
    return respond(200, customTemplate());
  });

  const { dialog } = await openCustomPanel();
  click(tabByText("Presentation"));
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

  const { dialog } = await openCustomPanel();

  click(tabByText("Presentation"));
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
  const editor = await findComposerEditor();
  await expect(
    within(editor).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
  // A deck's cover reaches the chip, which is what makes the document case
  // below a difference rather than a chip that never draws covers at all.
  await waitFor(() => {
    expect(
      editor.querySelector('img[src="https://example.test/cover.png"]'),
    ).not.toBeNull();
  });
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

  const { dialog } = await openCustomPanel(true, "Document");
  click(tabByText("Document"));
  const custom = within(dialog).getByRole("region", { name: "Custom" });

  await expect(
    within(custom).findByText("Brand report"),
  ).resolves.toBeInTheDocument();
  // Nothing was rendered for it, so the tile carries the format it was
  // compiled from rather than an empty frame.
  expect(within(custom).getByText("DOCX")).toBeInTheDocument();
  expect(
    within(custom).queryByTestId("document-cover-page"),
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

  const { dialog } = await openCustomPanel(true, "Document");
  click(tabByText("Document"));
  const custom = within(dialog).getByRole("region", { name: "Custom" });

  const page = await within(custom).findByTestId("document-cover-page");
  expect(page).toHaveAttribute("src", DOCUMENT_COVER_URL);
  // The page was rendered, so the format glyph steps aside for it.
  expect(within(custom).queryByText("DOCX")).not.toBeInTheDocument();
  // Two sheets for a source that continued, whether it continued for one more
  // page or three hundred: they carry no image, so there is nothing for a
  // third to add.
  expect(within(custom).getAllByTestId("document-cover-sheet")).toHaveLength(2);
});

test("Opening a Word template hands the source file to the Office viewer", async () => {
  mockCustomTemplateStore([documentTemplate()]);

  const { dialog } = await openCustomPanel(true, "Document");
  click(tabByText("Document"));
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

  const { dialog } = await openCustomPanel(true, "Document");
  click(tabByText("Document"));
  await within(dialog).findByText("Annual report");
  click(buttonByName("Preview Annual report", dialog)!);

  // A PDF needs neither our viewer nor Microsoft's: the browser renders it
  // from the source URL, handed over unchanged.
  const frame = await screen.findByTitle("annual-report.pdf preview");
  expect(frame).toHaveAttribute(
    "src",
    `${DOCUMENT_SOURCE_URL}#toolbar=0&navpanes=0&view=FitH`,
  );
});

const ILLUSTRATION_SOURCE_URL =
  "https://storage.example.test/private-artifacts/market-day.png?signature=abc";
const MARKET_DAY_EXAMPLE_URL =
  "https://storage.example.test/private-artifacts/ref-market-day.png?signature=def";

function illustrationTemplate(
  overrides: Partial<UserTemplateDetail> = {},
): UserTemplateDetail {
  return customTemplate({
    id: "44444444-4444-4444-8444-444444444444",
    title: "Market day",
    sourceFilename: "market-day.png",
    kind: "illustration",
    coverHasMorePages: false,
    pageCount: null,
    pageUrls: [],
    sourceUrl: ILLUSTRATION_SOURCE_URL,
    // Covered by the example its style produced, never by its source.
    coverUrl: MARKET_DAY_EXAMPLE_URL,
    previewAssets: [previewAsset("example-1", MARKET_DAY_EXAMPLE_URL)],
    ...overrides,
  });
}

function previewAsset(name: string, url: string) {
  return {
    previewAssetId: `utp:44444444-4444-4444-8444-444444444444:${name}`,
    url,
    expiresAt: "2026-12-31T00:00:00.000Z",
  };
}

const EXAMPLE_URLS = [
  "https://storage.example.test/private-artifacts/ref-agenda.png?signature=1",
  "https://storage.example.test/private-artifacts/ref-approval.png?signature=2",
  "https://storage.example.test/private-artifacts/ref-access.png?signature=3",
] as const;

/** An image template published with the examples its style produced. */
function exampledIllustrationTemplate(
  urls: readonly string[] = EXAMPLE_URLS,
): UserTemplateDetail {
  return illustrationTemplate({
    title: "Quiet UI mockup",
    sourceFilename: "design-review.png",
    coverUrl: urls[0],
    previewAssets: urls.map((url, index) => {
      return previewAsset(`example-${(index + 1).toString()}`, url);
    }),
  });
}

function exampleStrip(dialog: HTMLElement): HTMLElement[] {
  return queryAllByRoleFast(
    "button",
    within(dialog).getByRole("region", { name: "Custom" }),
  ).filter((button) => {
    return /^Show variant \d+$/.test(button.getAttribute("aria-label") ?? "");
  });
}

test("An image template is shown by the examples its style produced, not its source", async () => {
  mockCustomTemplateStore([exampledIllustrationTemplate()]);

  const { dialog } = await openCustomPanel(true, "Image");
  await within(dialog).findByText("Quiet UI mockup");

  const hero = () => {
    return within(dialog).getByAltText("Quiet UI mockup illustration preview");
  };
  expect(hero()).toHaveAttribute("src", EXAMPLE_URLS[0]);
  const strip = exampleStrip(dialog);
  expect(
    strip.map((button) => {
      return button.querySelector("img")?.getAttribute("src");
    }),
  ).toStrictEqual([...EXAMPLE_URLS]);
  expect(strip[0]).toHaveAttribute("aria-pressed", "true");

  click(strip[1]!);
  await waitFor(() => {
    expect(hero()).toHaveAttribute("src", EXAMPLE_URLS[1]);
  });
  expect(exampleStrip(dialog)[1]).toHaveAttribute("aria-pressed", "true");

  // Like the built-in Illustration card, the picture steps through the
  // examples rather than opening a page of its own.
  click(hero());
  await waitFor(() => {
    expect(hero()).toHaveAttribute("src", EXAMPLE_URLS[2]);
  });
  expect(exampleStrip(dialog)[2]).toHaveAttribute("aria-pressed", "true");
});

test("An image template with one example has nothing to choose between", async () => {
  mockCustomTemplateStore([exampledIllustrationTemplate([EXAMPLE_URLS[0]])]);

  const { dialog } = await openCustomPanel(true, "Image");
  await within(dialog).findByText("Quiet UI mockup");

  expect(
    within(dialog).getByAltText("Quiet UI mockup illustration preview"),
  ).toHaveAttribute("src", EXAMPLE_URLS[0]);
  expect(exampleStrip(dialog)).toStrictEqual([]);
  expect(within(dialog).getByText("Private")).toBeInTheDocument();
});

test("Rename an image template from its card menu", async () => {
  mockCustomTemplateStore([exampledIllustrationTemplate()]);

  const { dialog } = await openCustomPanel(true, "Image");
  await within(dialog).findByText("Quiet UI mockup");

  click(buttonByName("Actions for Quiet UI mockup", dialog)!);
  await waitFor(() => {
    expect(menuItemByName("Rename")).toBeInTheDocument();
  });
  click(menuItemByName("Rename"));

  const rename = await screen.findByRole("dialog", { name: "Rename template" });
  const field = within(rename).getByLabelText("Rename template");
  expect(field).toHaveValue("Quiet UI mockup");
  await fill(field, "  Quiet   UI kit  ");
  click(buttonByName("Save", rename)!);

  // Whitespace is collapsed before it is stored, and the dialog closes once
  // the name is saved.
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Rename template" }),
    ).not.toBeInTheDocument();
  });
  await expect(
    within(dialog).findByText("Quiet UI kit"),
  ).resolves.toBeInTheDocument();
  expect(tabByText("Image")).toHaveAttribute("aria-selected", "true");
});

test("A rename the server refuses keeps the dialog and the typed name", async () => {
  mockCustomTemplateStore([exampledIllustrationTemplate()], {
    update: () => {
      return "fail";
    },
  });

  const { dialog } = await openCustomPanel(true, "Image");
  await within(dialog).findByText("Quiet UI mockup");

  click(buttonByName("Actions for Quiet UI mockup", dialog)!);
  await waitFor(() => {
    expect(menuItemByName("Rename")).toBeInTheDocument();
  });
  click(menuItemByName("Rename"));

  const rename = await screen.findByRole("dialog", { name: "Rename template" });
  const field = within(rename).getByLabelText("Rename template");
  await fill(field, "Quiet UI kit");
  click(buttonByName("Save", rename)!);

  await expect(
    within(rename).findByText("Couldn't rename the template."),
  ).resolves.toBeInTheDocument();
  expect(field).toHaveValue("Quiet UI kit");
  expect(within(dialog).getByText("Quiet UI mockup")).toBeInTheDocument();
});

async function openDetail(
  dialog: HTMLElement,
  title: string,
): Promise<HTMLElement> {
  click(tabByText("Presentation"));
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

test.each([
  { mode: "composing", isComposing: true, keyCode: 13, title: "季度 报告" },
  {
    mode: "Safari final Enter",
    isComposing: false,
    keyCode: 229,
    title: "四半期 レポート",
  },
])(
  "Confirming an IME candidate ($mode) keeps the template name focused and unsaved",
  async ({ isComposing, keyCode, title }) => {
    const user = userEvent.setup({ delay: null });
    mockCustomTemplateStore([customTemplate()]);
    const { dialog } = await openCustomPanel();
    const input = await openDetail(dialog, "Q3 board review");

    fireEvent.compositionStart(input);
    await fill(input, `  ${title}  `);
    if (!isComposing) {
      fireEvent.compositionEnd(input, { data: title });
    }
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      isComposing,
      keyCode,
    });

    expect(input).toHaveFocus();
    expect(input).toBeEnabled();
    expect(input).toHaveValue(`  ${title}  `);
    expect(within(dialog).getByText("Q3 board review")).toBeInTheDocument();

    if (isComposing) {
      fireEvent.compositionEnd(input, { data: title });
    }
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(renameField()).toHaveValue(title);
    });
    expect(renameField()).not.toHaveFocus();
    expect(renameField()).toBeEnabled();
    closeDetail();
    await expect(within(dialog).findByText(title)).resolves.toBeInTheDocument();
  },
);

function renameField(): HTMLElement {
  return screen.getByLabelText("Rename template");
}

async function shareWithOrganization(): Promise<void> {
  click(
    (await screen.findByText("Change template visibility")).closest("button")!,
  );
  const organization = await waitFor(() => {
    const option = queryAllByRoleFast("menuitemradio").find((candidate) => {
      return candidate.textContent?.startsWith("Organization");
    });
    if (!option) {
      throw new Error("Expected an Organization visibility option");
    }
    return option;
  });
  click(organization);
}

test("A rejected rename keeps the typed name", async () => {
  mockCustomTemplateStore([customTemplate()], {
    update: () => {
      return "fail";
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

test("Deleting an image template keeps its category and other cards", async () => {
  const board = exampledIllustrationTemplate();
  const renewal = exampledIllustrationTemplate();
  const remaining = {
    ...renewal,
    id: "22222222-2222-4222-8222-222222222222",
    title: "Renewal style",
  };
  mockCustomTemplateStore([board, remaining]);

  const { dialog } = await openCustomPanel(true, "Image");
  await within(dialog).findByText(board.title);

  click(buttonByName(`Actions for ${board.title}`, dialog)!);
  await waitFor(() => {
    expect(menuItemByName("Delete")).toBeInTheDocument();
  });
  click(menuItemByName("Delete"));
  // Removal cannot be undone, so the menu asks first and changes nothing yet.
  const confirm = await screen.findByRole("dialog", {
    name: "Delete template?",
  });
  expect(within(dialog).getByText(board.title)).toBeInTheDocument();
  click(buttonByName("Delete template", confirm)!);

  await waitFor(() => {
    expect(within(dialog).queryByText(board.title)).not.toBeInTheDocument();
  });
  expect(within(dialog).getByText(remaining.title)).toBeInTheDocument();
  expect(tabByText("Image")).toHaveAttribute("aria-selected", "true");
});

test("Cancelling the delete confirmation keeps the template", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText("Q3 board review");

  click(buttonByName("Actions for Q3 board review", dialog)!);
  await waitFor(() => {
    expect(menuItemByName("Delete")).toBeInTheDocument();
  });
  click(menuItemByName("Delete"));
  const confirm = await screen.findByRole("dialog", {
    name: "Delete template?",
  });
  click(buttonByName("Cancel", confirm)!);

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Delete template?" }),
    ).not.toBeInTheDocument();
  });
  expect(within(dialog).getByText("Q3 board review")).toBeInTheDocument();
});

test("A failed deletion is not reported again on the next confirmation", async () => {
  let deletions = 0;
  mockCustomTemplateStore([customTemplate()], {
    delete: () => {
      deletions += 1;
      return deletions === 1 ? "fail" : undefined;
    },
  });

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText("Q3 board review");

  const askToDelete = async () => {
    click(buttonByName("Actions for Q3 board review", dialog)!);
    await waitFor(() => {
      expect(menuItemByName("Delete")).toBeInTheDocument();
    });
    click(menuItemByName("Delete"));
    return await screen.findByRole("dialog", { name: "Delete template?" });
  };

  const first = await askToDelete();
  click(buttonByName("Delete template", first)!);
  await expect(
    within(first).findByText("Couldn't delete the template. Try again."),
  ).resolves.toBeInTheDocument();
  click(buttonByName("Cancel", first)!);
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Delete template?" }),
    ).not.toBeInTheDocument();
  });

  // The next question is about a request that has not been made yet.
  const second = await askToDelete();
  expect(within(second).getByText(/Q3 board review/)).toBeInTheDocument();
  expect(
    within(second).queryByText("Couldn't delete the template. Try again."),
  ).not.toBeInTheDocument();

  click(buttonByName("Delete template", second)!);
  await waitFor(() => {
    expect(within(dialog).queryByText("Q3 board review")).toBeNull();
  });
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
      const confirm = await screen.findByRole("dialog", {
        name: "Delete template?",
      });
      click(buttonByName("Delete template", confirm)!);
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

test("Each content type owns a format-specific import tile", async () => {
  mockCustomTemplates([customTemplate()]);
  const { dialog } = await openCustomPanel();
  await within(dialog).findByText("Q3 board review");
  expect(within(dialog).getByLabelText("Import your own deck")).toHaveAttribute(
    "accept",
    ".pptx,.ppt,.pdf",
  );
  click(tabByText("Document"));
  expect(
    within(dialog).getByLabelText("Import your own document"),
  ).toHaveAttribute("accept", ".docx,.doc");
  click(tabByText("Image"));
  expect(within(dialog).getByLabelText("Import your own")).toHaveAttribute(
    "accept",
    ".png,.jpg,.jpeg,.webp,.bmp",
  );
});

test("Importing a document uses the custom template dispatcher", async () => {
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

  click(tabByText("Document"));
  await user.upload(
    await within(dialog).findByLabelText("Import your own document"),
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

  click(tabByText("Document"));
  await user.upload(
    await within(dialog).findByLabelText("Import your own document"),
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

test("Custom is a document filter beside All and the built-in purposes", async () => {
  mockCustomTemplates([documentTemplate()]);
  const { dialog } = await openCustomPanel(true, "Document");
  const custom = within(dialog).getByRole("region", { name: "Custom" });
  await within(custom).findByText("Brand report");
  expect(
    within(dialog).getByRole("region", { name: "Built-in" }),
  ).toBeInTheDocument();
  click(buttonByName("Reports", dialog)!);
  expect(
    within(dialog).queryByRole("region", { name: "Custom" }),
  ).not.toBeInTheDocument();
  expect(within(dialog).getByText("Two-column report")).toBeInTheDocument();
  click(buttonByName("Custom", dialog)!);
  await expect(
    within(dialog).findByText("Brand report"),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).queryByRole("region", { name: "Built-in" }),
  ).not.toBeInTheDocument();
});

test("A failed custom catalog leaves built-in templates available and can retry", async () => {
  let fail = true;
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return fail
      ? respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Unavailable" },
        })
      : respond(200, [customTemplate()]);
  });
  const { dialog } = await openCustomPanel();
  const custom = within(dialog).getByRole("region", { name: "Custom" });
  const retry = await waitFor(() => {
    const button = buttonByName("Try again", custom);
    expect(button).toBeTruthy();
    return button!;
  });
  expect(
    within(dialog).getByRole("region", { name: "Built-in" }),
  ).toBeInTheDocument();
  expect(within(custom).getByLabelText("Import your own deck")).toBeEnabled();
  fail = false;
  click(retry);
  await expect(
    within(custom).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
});
