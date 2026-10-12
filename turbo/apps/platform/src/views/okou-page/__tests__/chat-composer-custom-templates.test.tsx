import {
  userTemplatesContract,
  type UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  buttonByName,
  customTemplate,
  documentTemplate,
  illustrationTemplate,
  mockCustomTemplates,
  mockCustomTemplateStore,
  openCustomPanel,
  queryTabByText,
  tabByText,
} from "./chat-composer-custom-template-test-helpers.ts";
import { context } from "./chat-composer-template-gallery-test-helpers.ts";

function kindLabels(filters: HTMLElement): string[] {
  return queryAllByRoleFast("radio", filters).map((radio) => {
    return radio.textContent?.trim() ?? "";
  });
}

function kindByName(name: string, filters: HTMLElement): HTMLElement {
  const kind = queryAllByRoleFast("radio", filters).find((radio) => {
    return radio.textContent?.trim() === name;
  });
  if (!kind) {
    throw new Error(`Expected a kind named "${name}"`);
  }
  return kind;
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

test("Kind filters combine with search without an All option", async () => {
  mockCustomTemplates([
    customTemplate(),
    documentTemplate(),
    illustrationTemplate(),
  ]);

  const { dialog } = await openCustomPanel();
  const filters = await within(dialog).findByRole("radiogroup", {
    name: "Template categories",
  });

  click(kindByName("Document", filters));
  await expect(
    within(dialog).findByText("Brand report"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();
  expect(within(dialog).queryByText("Market day")).not.toBeInTheDocument();

  click(kindByName("Presentation", filters));
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Brand report")).not.toBeInTheDocument();

  click(kindByName("Image", filters));
  await expect(
    within(dialog).findByText("Market day"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();

  const search = within(dialog).getByPlaceholderText("Search templates");
  await fill(search, "brand-report.docx");
  await expect(
    within(dialog).findByText("No matches"),
  ).resolves.toBeInTheDocument();
  expect(kindByName("Image", filters)).toBeChecked();

  click(kindByName("Document", filters));
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
  expect(kindLabels(filters)).toStrictEqual([
    "Document",
    "Presentation",
    "Image",
  ]);
});

test("An empty kind keeps the search and kind filters in place", async () => {
  mockCustomTemplates([customTemplate()]);
  const { dialog } = await openCustomPanel();
  const filters = await within(dialog).findByRole("radiogroup", {
    name: "Template categories",
  });
  click(kindByName("Image", filters));
  await expect(
    within(dialog).findByText("No images yet"),
  ).resolves.toBeInTheDocument();
  // The toolbar does not change shape between kinds: the search stays, and
  // the kind filters remain so the member can leave the empty kind.
  expect(within(dialog).getByLabelText("Search templates")).toBeInTheDocument();
  const emptyKindFilters = within(dialog).getByRole("radiogroup", {
    name: "Template categories",
  });
  expect(kindByName("Image", emptyKindFilters)).toBeChecked();
  expect(within(dialog).getAllByLabelText("Import template")).toHaveLength(1);
  click(kindByName("Presentation", emptyKindFilters));
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
  expect(kindByName("Presentation", emptyKindFilters)).toBeChecked();
});

test("Returning to Custom shows the loaded catalog without waiting on the network", async () => {
  // Once the member has left Custom, any further catalog request stays
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
  click(tabByText("Presentation"));
  await waitFor(() => {
    expect(within(dialog).queryByText("Q3 board review")).toBeNull();
  });
  click(tabByText("Custom"));

  // Reloading on every return blanked the pane until the request answered.
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByLabelText("Search templates")).toBeInTheDocument();
});

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
