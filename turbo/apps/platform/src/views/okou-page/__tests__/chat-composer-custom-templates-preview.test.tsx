import {
  userTemplatesContract,
  type UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  DOCUMENT_SOURCE_URL,
  buttonByName,
  customTemplate,
  documentTemplate,
  illustrationTemplate,
  mockCustomTemplates,
  mockCustomTemplateStore,
  openCustomPanel,
  previewAsset,
  tabByText,
} from "./chat-composer-custom-template-test-helpers.ts";
import { context } from "./chat-composer-template-gallery-test-helpers.ts";

function previewDialogAround(inside: HTMLElement): HTMLElement {
  const preview = inside.closest<HTMLElement>('[role="dialog"]');
  if (!preview) {
    throw new Error("Source preview dialog not found");
  }
  return preview;
}

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
  // A deck's cover reaches the chip, which is what makes the document case
  // below a difference rather than a chip that never draws covers at all.
  await waitFor(() => {
    expect(
      document.querySelector('img[src="https://example.test/cover.png"]'),
    ).not.toBeNull();
  });
});

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
  return queryAllByRoleFast("button", dialog).filter((button) => {
    return /^Show variant \d+$/.test(button.getAttribute("aria-label") ?? "");
  });
}

test("An image template is shown by the examples its style produced, not its source", async () => {
  mockCustomTemplateStore([exampledIllustrationTemplate()]);

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText("Quiet UI mockup");

  const hero = () => {
    return buttonByName("Preview Quiet UI mockup", dialog)?.querySelector(
      "img",
    );
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

  click(buttonByName("Preview Quiet UI mockup", dialog)!);
  const pictures = await screen.findAllByTestId(
    "custom-template-example-preview",
  );
  expect(
    pictures.map((picture) => {
      return picture.getAttribute("src");
    }),
  ).toStrictEqual([...EXAMPLE_URLS]);
});

test("An image template with one example has nothing to choose between", async () => {
  mockCustomTemplateStore([exampledIllustrationTemplate([EXAMPLE_URLS[0]])]);

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText("Quiet UI mockup");

  expect(
    buttonByName("Preview Quiet UI mockup", dialog)?.querySelector("img"),
  ).toHaveAttribute("src", EXAMPLE_URLS[0]);
  expect(exampleStrip(dialog)).toStrictEqual([]);
  expect(within(dialog).getByText("Private")).toBeInTheDocument();
});
