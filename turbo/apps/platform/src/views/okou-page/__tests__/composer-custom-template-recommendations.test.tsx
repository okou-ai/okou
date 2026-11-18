import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  userTemplatesContract,
  type UserTemplateCatalogEntry,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { DOCUMENT_TEMPLATE_ITEMS } from "@okouai/core/document-template-items";
import { screen, waitFor, within } from "@testing-library/react";
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
  tabByText,
} from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
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
    path: `/agents/${AGENT_ID}/chat`,
  });
  const editor = await findComposerEditor();
  if (draft) {
    await fill(editor, draft);
  }
  const create = within(
    screen.getByRole("group", { name: "Explore Okou capabilities" }),
  ).getByRole("region", { name: "Create" });
  click(button("Presentation", create));
  const types = await screen.findByRole("radiogroup", { name: "Create" });
  const choice = queryAllByRoleFast("radio", types).find((item) => {
    return item.textContent?.trim() === task;
  });
  if (!choice) {
    throw new Error(`Expected creation type ${task}`);
  }
  click(choice);
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
    const { editor, tray } = await openShelf(entry, entryShelf);
    click(button("View all", tray));
    const dialog = await screen.findByRole("dialog");
    click(
      tabByText(
        kind === "presentation"
          ? "Presentation"
          : kind === "document"
            ? "Document"
            : "Image",
      ),
    );
    await within(dialog).findByText(own.title);
    click(button("Use", dialog));
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
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

test.each(["shelf", "picker"] as const)(
  "The Document %s imports a reusable document without requesting document generation",
  async (entry) => {
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
    const { shelf, tray } = await openShelf(
      "Document",
      "Document templates",
      "",
    );
    let importSurface = shelf;
    if (entry === "picker") {
      click(button("View all", tray));
      importSurface = await screen.findByRole("dialog");
      click(button("Custom", importSurface));
    }
    await userEvent.setup({ delay: null }).upload(
      within(importSurface).getByLabelText("Import your own document"),
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
  },
);

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
