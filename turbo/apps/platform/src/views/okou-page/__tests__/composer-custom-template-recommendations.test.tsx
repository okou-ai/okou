import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  userTemplatesContract,
  type UserTemplateCatalogEntry,
  type UserTemplateKind,
  type UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { DOCUMENT_TEMPLATE_ITEMS } from "@okouai/core/document-template-items";
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
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import {
  createTemplateGalleryHelpers,
  openTemplateRecommendations,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

function template(kind: UserTemplateKind): UserTemplateCatalogEntry {
  const id = {
    presentation: "11111111-1111-4111-8111-111111111111",
    illustration: "22222222-2222-4222-8222-222222222222",
    document: "33333333-3333-4333-8333-333333333333",
  }[kind];
  return {
    id,
    kind,
    title: `My ${kind} template`,
    sourceFilename: `source-${kind}.pdf`,
    coverUrl: `https://example.test/${kind}-cover.png`,
    coverHasMorePages: kind === "presentation",
    pageCount: kind === "presentation" ? 12 : null,
    visibility: "private",
    ownerUserId: "user_self",
    ownerDisplayName: "Dana Self",
    canManage: true,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    previewAssets: [
      {
        previewAssetId: `utp:${id}:example`,
        url: `https://example.test/${kind}-example.png`,
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
    ],
  };
}

function button(name: string, container: ParentNode = document.body) {
  const result = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!result) {
    throw new Error(`Expected button ${name}`);
  }
  return result;
}

const SHELVES = [
  {
    task: "Presentation",
    kind: "presentation",
    label: "Presentation templates",
    builtInTitle: PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!.title,
  },
  {
    task: "Image",
    kind: "illustration",
    label: "Image styles",
    builtInTitle: ILLUSTRATION_TEMPLATE_ITEMS[0]!.title,
  },
] as const;
const DOCUMENT_SHELF = {
  task: "Document",
  kind: "document",
  label: "Document templates",
  builtInTitle: DOCUMENT_TEMPLATE_ITEMS[0]!.title,
} as const;
const ALL_SHELVES = [...SHELVES, DOCUMENT_SHELF] as const;

async function openShelf(
  task: string,
  label: string,
  draft = "Keep my launch brief",
) {
  await setupPage({
    context,
    path: `/`,
  });
  const editor = await findComposerEditor();
  if (draft) {
    await fill(editor, draft);
  }
  const create = within(
    screen.getByRole("group", { name: "Explore Okou capabilities" }),
  ).getByRole("region", { name: "Create" });
  click(button(task, create));
  const shelf = await screen.findByRole("group", { name: label });
  return { editor, shelf, tray: screen.getByRole("tabpanel") };
}

function mockShelfCatalog(kind: UserTemplateKind) {
  const capture = mockTemplateChat();
  const own = template(kind);
  const shared = {
    ...own,
    id: "44444444-4444-4444-8444-444444444444",
    title: "Shared brand template",
    visibility: "organization" as const,
    ownerUserId: "user_colleague",
    canManage: false,
  };
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, [
      template("presentation"),
      template("illustration"),
      template("document"),
      shared,
    ]);
  });
  return { capture, own, shared };
}

test.each(ALL_SHELVES)(
  "The $task homepage shelf orders import, custom templates and built-ins and uses the selected custom template",
  async ({ task, kind, label, builtInTitle }) => {
    const { capture, own, shared } = mockShelfCatalog(kind);
    const { editor, shelf } = await openShelf(task, label);
    const customTitle = await within(shelf).findByText(own.title);
    const sharedTitle = within(shelf).getByText(shared.title);
    const builtInTitleElement = within(shelf).getByText(builtInTitle);
    const importLabel = {
      presentation: "Import your own deck",
      illustration: "Import your own",
      document: "Import your own document",
    }[kind];
    const importInput = within(shelf).getByLabelText(importLabel);
    expect(
      importInput.compareDocumentPosition(customTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      customTitle.compareDocumentPosition(builtInTitleElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      sharedTitle.compareDocumentPosition(builtInTitleElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    click(
      button(
        kind === "presentation" ? own.title : `Use template ${own.title}`,
        shelf,
      ),
    );
    await waitFor(() => {
      expect(editor).toHaveTextContent(own.title);
    });
    expect(editor).toHaveTextContent("Keep my launch brief");
    click(button("Send"));
    await waitFor(() => {
      expect(capture.selectedTemplates).toStrictEqual([
        { type: "custom", selection: { userTemplateId: own.id } },
      ]);
    });
  },
);

test.each(SHELVES)(
  "$task shows accessible custom templates only of its kind",
  async ({ task, kind, label, builtInTitle }) => {
    const { own, shared } = mockShelfCatalog(kind);
    const { shelf } = await openShelf(task, label, "");
    await within(shelf).findByText(own.title);
    expect(within(shelf).getByText(shared.title)).toBeInTheDocument();
    expect(within(shelf).getByText(builtInTitle)).toBeInTheDocument();
    expect(
      within(shelf).queryByText("My document template"),
    ).not.toBeInTheDocument();
    const otherKind = kind === "presentation" ? "illustration" : "presentation";
    expect(
      within(shelf).queryByText(template(otherKind).title),
    ).not.toBeInTheDocument();
    expect(
      within(shelf)
        .getByText(own.title)
        .closest("button")
        ?.querySelector("img"),
    ).toHaveAttribute(
      "src",
      kind === "presentation" ? own.coverUrl : own.previewAssets[0]!.url,
    );
  },
);

test.each([
  {
    kind: "presentation",
    entry: "Image",
    entryShelf: "Image styles",
    tasks: ["Remove Presentation"],
    instructions: [expect.stringContaining("Create a presentation.")],
  },
  {
    kind: "illustration",
    entry: "Presentation",
    entryShelf: "Presentation templates",
    tasks: ["Remove Image"],
    instructions: ["Create an image."],
  },
  {
    kind: "document",
    entry: "Presentation",
    entryShelf: "Presentation templates",
    tasks: ["Remove Document"],
    instructions: ["Create a document."],
  },
] as const)(
  "Selecting a custom $kind template from another catalog updates the creation task",
  async ({ kind, entry, entryShelf, tasks, instructions }) => {
    const capture = mockTemplateChat();
    context.mocks.data.userPreferences({ timezone: "UTC", locale: "en-US" });
    context.mocks.data.availableRunModels([
      buildRunModel({
        model: "claude-sonnet-5",
        modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      }),
    ]);
    const own = template(kind);
    context.mocks.api(userTemplatesContract.list, ({ respond }) => {
      return respond(200, [own]);
    });
    const { editor } = await openShelf(entry, entryShelf);
    const task =
      kind === "presentation"
        ? "Presentation"
        : kind === "document"
          ? "Document"
          : "Image";
    const types = screen.getByRole("radiogroup", { name: "Create" });
    const choice = queryAllByRoleFast("radio", types).find((candidate) => {
      return candidate.textContent?.trim() === task;
    });
    if (!choice) {
      throw new Error(`Expected creation type ${task}`);
    }
    click(choice);
    const shelf = await screen.findByRole("group", {
      name: kind === "illustration" ? "Image styles" : `${task} templates`,
    });
    await within(shelf).findByText(own.title);
    click(
      button(
        kind === "presentation" ? own.title : `Use template ${own.title}`,
        shelf,
      ),
    );
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").flatMap((item) => {
          const label = item.getAttribute("aria-label");
          return label === "Remove Presentation" ||
            label === "Remove Image" ||
            label === "Remove Document"
            ? [label]
            : [];
        }),
      ).toStrictEqual(tasks);
    });
    expect(editor).toHaveTextContent(own.title);
    expect(editor).toHaveTextContent("Keep my launch brief");
    click(button("Send"));
    await waitFor(() => {
      expect(capture.selectedTemplates).toStrictEqual([
        { type: "custom", selection: { userTemplateId: own.id } },
      ]);
    });
    expect(
      capture.sentMessages[0]?.parts.flatMap((part) => {
        return part.type === "additional_info" ? [part.text] : [];
      }),
    ).toStrictEqual(instructions);
  },
);

test("The Image shelf imports a reusable style without requesting image generation", async () => {
  const capture = mockTemplateChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000024",
    filename: "brand.webp",
    contentType: "image/webp",
    size: 5,
    url: "https://cdn.example.test/brand.webp",
  });
  const user = userEvent.setup({ delay: null });
  const { editor, shelf } = await openShelf("Image", "Image styles");
  const input = within(shelf).getByLabelText("Import your own");
  expect(input).toHaveAttribute("accept", ".png,.jpg,.jpeg,.webp,.bmp");
  await user.upload(
    input,
    new File(["deck"], "brand.pdf", { type: "application/pdf" }),
  );
  expect(capture.sentMessages).toHaveLength(0);
  expect(editor).toHaveTextContent("Keep my launch brief");
  expect(button("Remove Image")).toBeInTheDocument();
  await user.upload(
    input,
    new File(["brand"], "brand.webp", { type: "image/webp" }),
  );
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual([
    "Analyse this file and save it as a reusable template.",
  ]);
  expect(capture.sentMessages[0]?.parts).toContainEqual(
    expect.objectContaining({ type: "file", filenameSnapshot: "brand.webp" }),
  );
  expect(capture.sentMessages[0]?.parts).toContainEqual(
    expect.objectContaining({
      type: "additional_info",
      text: expect.stringContaining("okou user-template publish"),
    }),
  );
  expect(capture.selectedTemplates).toStrictEqual([]);
  await waitFor(() => {
    expect(window.location.pathname).toMatch(/^\/chats\//);
  });
});

test.each(ALL_SHELVES)(
  "$task refreshes published and removed custom templates while the shelf stays open",
  async ({ task, kind, label }) => {
    mockTemplateChat();
    let catalog = [template(kind)];
    context.mocks.api(userTemplatesContract.list, ({ respond }) => {
      return respond(200, catalog);
    });
    const { shelf } = await openShelf(task, label);
    await within(shelf).findByText(template(kind).title);
    catalog = [
      {
        ...template(kind),
        title: "Newly published template",
        id: "66666666-6666-4666-8666-666666666666",
      },
    ];
    context.mocks.ably.trigger("presentationTemplatesChanged");
    await within(shelf).findByText("Newly published template");
    expect(
      within(shelf).queryByText(template(kind).title),
    ).not.toBeInTheDocument();
  },
);

test("The Document shelf imports a reusable document without requesting document generation", async () => {
  const capture = mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, []);
  });
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000025",
    filename: "brand.docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 5,
    url: "https://cdn.example.test/brand.docx",
  });
  const { shelf } = await openShelf("Document", "Document templates", "");
  await userEvent.setup({ delay: null }).upload(
    within(shelf).getByLabelText("Import your own document"),
    new File(["brand"], "brand.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual([
    "Analyse this file and save it as a reusable template.",
  ]);
  expect(capture.sentMessages[0]?.parts).toContainEqual(
    expect.objectContaining({ type: "file", filenameSnapshot: "brand.docx" }),
  );
  expect(capture.sentMessages[0]?.parts).toContainEqual(
    expect.objectContaining({
      type: "additional_info",
      text: expect.stringContaining("okou user-template publish"),
    }),
  );
  expect(capture.sentMessages[0]?.parts).not.toContainEqual(
    expect.objectContaining({
      type: "additional_info",
      text: expect.stringContaining("Create a document."),
    }),
  );
  expect(capture.selectedTemplates).toStrictEqual([]);
});

test("A built-in presentation stays usable while custom templates load", async () => {
  const capture = mockTemplateChat();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    userTemplatesContract.list,
    async ({ respond, withSignal }) => {
      await withSignal(release.promise);
      return respond(200, []);
    },
  );
  const { editor, shelf } = await openShelf(
    "Presentation",
    "Presentation templates",
  );
  const builtIn = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
  click(button(builtIn.title, shelf));
  await waitFor(() => {
    expect(editor).toHaveTextContent(builtIn.title);
  });
  expect(editor).toHaveTextContent("Keep my launch brief");
  expect(capture.sentMessages).toHaveLength(0);
  release.resolve();
});

test("A failed custom catalog still shows built-in document templates and import", async () => {
  mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Catalog unavailable" },
    });
  });
  const { shelf } = await openShelf("Document", "Document templates");
  await within(shelf).findByLabelText("Use template Content brief");
  expect(
    within(shelf).getAllByLabelText(/^Use template /u).length,
  ).toBeGreaterThan(0);
  expect(
    within(shelf).getByLabelText("Import your own document"),
  ).toBeInTheDocument();
});

function detailTemplate(
  overrides: Partial<UserTemplateDetail> = {},
): UserTemplateDetail {
  return {
    ...template("presentation"),
    title: "Q3 board review",
    sourceFilename: "q3-board.pptx",
    sourceUrl: "https://example.test/source.pptx?signature=fixture",
    pageUrls: [
      "https://example.test/page-1.png",
      "https://example.test/page-2.png",
    ],
    ...overrides,
  };
}

function mockDetailStore(
  initial: UserTemplateDetail,
  failUpdate = () => {
    return false;
  },
) {
  let current = initial;
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    const { pageUrls: _pageUrls, sourceUrl: _sourceUrl, ...entry } = current;
    return respond(200, [entry]);
  });
  context.mocks.api(userTemplatesContract.get, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(userTemplatesContract.update, ({ body, respond }) => {
    if (failUpdate()) {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "User template request failed",
        },
      });
    }
    current = { ...current, ...body };
    const {
      pageUrls: _pageUrls,
      sourceUrl: _sourceUrl,
      previewAssets: _previewAssets,
      ...entry
    } = current;
    return respond(200, entry);
  });
}

async function openCustomDetail(detail: UserTemplateDetail) {
  const capture = mockTemplateChat();
  await setupPage({ context, path: "/" });
  const editor = await findComposerEditor();
  await fill(editor, "Keep my launch brief");
  const shelf = await openTemplateRecommendations(
    detail.kind === "document" ? "Document" : "Presentation",
  );
  const eye = await waitFor(() => {
    return button(`Preview template ${detail.title}`, shelf);
  });
  await userEvent.click(eye);
  const content =
    detail.kind === "document"
      ? await screen.findByTitle(`${detail.sourceFilename} preview`)
      : await screen.findByAltText("Page 1");
  const dialog = content.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) {
    throw new Error("Expected custom template detail dialog");
  }
  return { capture, editor, shelf, eye, dialog };
}

async function closeCustomDetail(dialog: HTMLElement) {
  click(button("Close", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
}

async function shareWithOrganization(dialog: HTMLElement) {
  const trigger = within(dialog)
    .getByText("Change template visibility")
    .closest("button");
  if (!trigger) {
    throw new Error("Expected template visibility trigger");
  }
  click(trigger);
  const organization = await waitFor(() => {
    const option = queryAllByRoleFast("menuitemradio").find((candidate) => {
      return candidate.getAttribute("aria-label") === "Organization";
    });
    if (!option) {
      throw new Error("Expected Organization visibility option");
    }
    return option;
  });
  click(organization);
}

test("A shared custom recommendation opens its owner attribution without management controls", async () => {
  const detail = detailTemplate({
    canManage: false,
    visibility: "organization",
    ownerUserId: "user_colleague",
    ownerDisplayName: "Riley Park",
  });
  mockDetailStore(detail);
  const { dialog, shelf, eye, capture } = await openCustomDetail(detail);
  expect(within(dialog).getByText("Shared by Riley Park")).toBeInTheDocument();
  expect(
    within(dialog).queryByLabelText("Rename template"),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByText("Change template visibility"),
  ).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", dialog).find((candidate) => {
      return candidate.textContent?.trim() === "Delete";
    }),
  ).toBeUndefined();
  expect(button("Use this template", dialog)).toBeEnabled();
  await closeCustomDetail(dialog);
  await waitFor(() => {
    expect(eye).toHaveFocus();
  });
  expect(within(shelf).getByText(detail.title)).toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
});

test("A custom deck recommendation navigates its complete rendered pages", async () => {
  const detail = detailTemplate();
  mockDetailStore(detail);
  const { dialog } = await openCustomDetail(detail);
  expect(within(dialog).getByText("1 / 2")).toBeInTheDocument();
  expect(within(dialog).getByText("2 slides")).toBeInTheDocument();
  click(button("Preview slide 2", dialog));
  expect(within(dialog).getByAltText("Page 2")).toHaveAttribute(
    "src",
    detail.pageUrls[1],
  );
  expect(button("Preview next slide", dialog)).toBeDisabled();
});

test("A custom PDF recommendation opens its source in the browser viewer", async () => {
  const detail = detailTemplate({
    kind: "document",
    title: "Annual report",
    sourceFilename: "annual-report.pdf",
    sourceUrl: "https://example.test/report.pdf?signature=fixture",
    pageUrls: [],
    coverUrl: null,
    pageCount: null,
  });
  mockDetailStore(detail);
  const { dialog } = await openCustomDetail(detail);
  expect(
    within(dialog).getByTitle("annual-report.pdf preview"),
  ).toHaveAttribute(
    "src",
    `${detail.sourceUrl}#toolbar=0&navpanes=0&view=FitH`,
  );
});

test("Renaming a custom recommendation normalizes its title and updates the shelf", async () => {
  const detail = detailTemplate();
  mockDetailStore(detail);
  const { dialog, shelf, editor, capture } = await openCustomDetail(detail);
  const input = within(dialog).getByLabelText("Rename template");
  await fill(input, "  Board   review FY26  ");
  fireEvent.blur(input);
  await waitFor(() => {
    expect(screen.getByLabelText("Rename template")).toHaveValue(
      "Board review FY26",
    );
  });
  await closeCustomDetail(dialog);
  await within(shelf).findByText("Board review FY26");
  expect(editor).toHaveTextContent("Keep my launch brief");
  expect(capture.sentMessages).toHaveLength(0);
});

test("Clearing a custom detail title does not erase its stored name", async () => {
  const detail = detailTemplate();
  mockDetailStore(detail);
  const { dialog, shelf } = await openCustomDetail(detail);
  const input = within(dialog).getByLabelText("Rename template");
  await fill(input, "");
  fireEvent.blur(input);
  await closeCustomDetail(dialog);
  await within(shelf).findByText(detail.title);
  click(button(`Preview template ${detail.title}`, shelf));
  await expect(screen.findByLabelText("Rename template")).resolves.toHaveValue(
    detail.title,
  );
});

test("A rejected custom detail rename preserves the typed name and can recover", async () => {
  const detail = detailTemplate();
  let fail = true;
  mockDetailStore(detail, () => {
    return fail;
  });
  const { dialog, shelf } = await openCustomDetail(detail);
  const input = within(dialog).getByLabelText("Rename template");
  await fill(input, "Board review FY26");
  fireEvent.blur(input);
  await within(dialog).findByText("Couldn't rename the template.");
  expect(input).toBeEnabled();
  expect(input).toHaveValue("Board review FY26");
  expect(within(shelf).getByText(detail.title)).toBeInTheDocument();
  fail = false;
  click(input);
  fireEvent.blur(input);
  await within(shelf).findByText("Board review FY26");
  await closeCustomDetail(dialog);
  await within(shelf).findByText("Board review FY26");
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
  "Confirming an IME candidate ($mode) keeps a custom detail title focused and unsaved",
  async ({ isComposing, keyCode, title }) => {
    const detail = detailTemplate();
    mockDetailStore(detail);
    const { dialog, shelf } = await openCustomDetail(detail);
    const input = within(dialog).getByLabelText("Rename template");
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
    expect(within(shelf).getByText(detail.title)).toBeInTheDocument();
    if (isComposing) {
      fireEvent.compositionEnd(input, { data: title });
    }
    await userEvent.setup({ delay: null }).keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByLabelText("Rename template")).toHaveValue(title);
    });
    await closeCustomDetail(dialog);
    await within(shelf).findByText(title);
  },
);

test.each([false, true])(
  "Custom detail visibility persists only after a successful response with failure=%s",
  async (fails) => {
    const detail = detailTemplate();
    mockDetailStore(detail, () => {
      return fails;
    });
    const { dialog, shelf } = await openCustomDetail(detail);
    await shareWithOrganization(dialog);
    if (fails) {
      await screen.findByText("User template request failed");
    }
    await within(dialog).findByText(
      fails ? "Only you can see and use it" : "Organization",
    );
    await closeCustomDetail(dialog);
    click(button(`Preview template ${detail.title}`, shelf));
    await screen.findByLabelText("Rename template");
    expect(
      screen.getByText(
        fails
          ? "Only you can see and use it"
          : "Anyone in this organization can use it",
      ),
    ).toBeInTheDocument();
  },
);
