import {
  userTemplatesContract,
  type UserTemplateCatalogEntry,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
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
  buildRunModel,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  findComposerEditor,
  tabByText,
} from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  context,
  createUploadedTemplate,
  mockPresentationTemplateLibrary,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

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

async function openShelf(
  task: string,
  label: string,
  enabled = true,
  draft = "Keep my launch brief",
  builtinDocumentTemplates = task === "Document",
) {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: enabled,
      [FeatureSwitchKey.BuiltinDocumentTemplates]: builtinDocumentTemplates,
    },
  });
  const editor = await findComposerEditor();
  if (draft) {
    await fill(editor, draft);
  }
  click(button(task, screen.getByRole("group", { name: "Choose a task" })));
  const shelf = await screen.findByRole("group", { name: label });
  return { editor, shelf };
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
  mockPresentationTemplateLibrary([
    createUploadedTemplate({
      id: own.id,
      title: "Legacy deck",
      canManage: true,
    }),
  ]);
  return { capture, own, shared };
}

test.each(SHELVES)(
  "$task shows accessible custom templates only of its kind",
  async ({ task, kind, label, builtInTitle }) => {
    const { own, shared } = mockShelfCatalog(kind);
    const { shelf } = await openShelf(task, label, true, "");
    await within(shelf).findByText(own.title);
    expect(within(shelf).getByText(shared.title)).toBeInTheDocument();
    expect(within(shelf).getByText(builtInTitle)).toBeInTheDocument();
    expect(
      within(shelf).queryByText("My document template"),
    ).not.toBeInTheDocument();
    expect(within(shelf).queryByText("Legacy deck")).not.toBeInTheDocument();
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

test.each(SHELVES)(
  "$task sends the selected custom reference and preserves the draft text",
  async ({ task, kind, label }) => {
    const { capture, own } = mockShelfCatalog(kind);
    const { editor, shelf } = await openShelf(task, label);
    await within(shelf).findByText(own.title);
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

test.each([
  {
    kind: "presentation",
    entry: "Illustration",
    tasks: ["Remove Presentation"],
    instructions: [expect.stringContaining("Create a presentation.")],
  },
  {
    kind: "illustration",
    entry: "Presentation",
    tasks: ["Remove Image"],
    instructions: ["Create an image."],
  },
  {
    kind: "document",
    entry: "Presentation",
    tasks: ["Remove Document"],
    instructions: ["Create a document."],
  },
] as const)(
  "Selecting a custom $kind template updates the slash task",
  async ({ kind, entry, tasks, instructions }) => {
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
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.CustomTemplates]: true },
    });
    const editor = await findComposerEditor();
    await fill(editor, "Keep my launch brief /");
    const menu = await screen.findByTestId("slash-workflow-menu");
    click(button(entry, menu));
    const customTab = await waitFor(() => {
      return tabByText(
        kind === "presentation"
          ? "Presentation"
          : kind === "document"
            ? "Document"
            : "Image",
      );
    });
    const dialog = customTab.closest('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Expected the content type tab in a template dialog");
    }
    click(customTab);
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

test.each(SHELVES)(
  "$task keeps its existing catalog when Custom is disabled",
  async ({ task, kind, label, builtInTitle }) => {
    mockTemplateChat();
    context.mocks.api(userTemplatesContract.list, () => {
      throw new Error("A disabled custom catalog must not be requested");
    });
    const legacy = createUploadedTemplate({
      id: "55555555-5555-4555-8555-555555555555",
      title: "Existing uploaded deck",
      canManage: true,
    });
    mockPresentationTemplateLibrary([legacy]);

    const { shelf } = await openShelf(task, label, false);
    expect(
      within(shelf).queryByLabelText("Import your own"),
    ).not.toBeInTheDocument();
    expect(within(shelf).getByText(builtInTitle)).toBeInTheDocument();
    if (kind === "presentation") {
      await within(shelf).findByText(legacy.title);
    }
    expect(
      within(shelf).queryByText(template(kind).title),
    ).not.toBeInTheDocument();
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

test("A failed image import keeps the draft and does not start an analysis", async () => {
  const capture = mockTemplateChat();
  context.mocks.api(uploadsContract.prepare, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Upload failed" },
    });
  });
  const user = userEvent.setup({ delay: null });
  const { editor, shelf } = await openShelf("Image", "Image styles");

  await user.upload(
    within(shelf).getByLabelText("Import your own"),
    new File(["brand"], "brand.png", { type: "image/png" }),
  );
  await screen.findByText("Failed to upload brand.png");
  expect(capture.sentMessages).toHaveLength(0);
  expect(editor).toHaveTextContent("Keep my launch brief");
  expect(window.location.pathname).toBe(`/agents/${AGENT_ID}/chat`);
});

test.each(SHELVES)(
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

test("Document defaults to Custom when documents exist and separates built-in purposes", async () => {
  const { own, shared } = mockShelfCatalog("document");
  const { editor, shelf } = await openShelf("Document", "Document templates");
  await within(shelf).findByText(own.title);
  const categories = within(shelf).getByRole("group", {
    name: "Document category",
  });
  expect(button("Custom", categories)).toHaveAttribute("aria-pressed", "true");
  expect(within(shelf).getByText(shared.title)).toBeInTheDocument();
  expect(
    within(shelf).queryByText("My presentation template"),
  ).not.toBeInTheDocument();
  expect(
    within(shelf).queryByText("My illustration template"),
  ).not.toBeInTheDocument();
  expect(within(shelf).getAllByLabelText(/^Use template /u)).toHaveLength(2);
  expect(
    within(shelf).getByLabelText("Import your own document"),
  ).toHaveAttribute("accept", ".docx,.doc");
  expect(
    button(`Use template ${own.title}`, shelf).querySelector("img"),
  ).toHaveAttribute("src", own.previewAssets[0]!.url);

  click(button(`Use template ${own.title}`, shelf));
  click(button("Reports", categories));
  expect(
    within(shelf).queryByLabelText("Import your own document"),
  ).not.toBeInTheDocument();
  expect(within(shelf).queryByText(own.title)).not.toBeInTheDocument();
  expect(within(shelf).getAllByLabelText(/^Use template /u)).toHaveLength(5);
  expect(editor).toHaveTextContent("Keep my launch brief");
  expect(editor).toHaveTextContent(own.title);

  click(button("More templates", shelf));
  const dialog = await screen.findByRole("dialog");
  expect(button("Reports", dialog)).toHaveAttribute("aria-pressed", "true");
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  click(button("Custom", categories));
  expect(
    within(shelf).getByLabelText("Import your own document"),
  ).toBeInTheDocument();
  expect(within(shelf).getByText(own.title)).toBeInTheDocument();
});

test("Document with no custom documents starts on Creative brief and keeps import inside Custom", async () => {
  mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, [template("presentation"), template("illustration")]);
  });
  const { shelf } = await openShelf("Document", "Document templates");
  await waitFor(() => {
    expect(button("Creative brief", shelf)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  expect(
    within(shelf).queryByLabelText("Import your own document"),
  ).not.toBeInTheDocument();
  click(button("Custom", shelf));
  expect(
    within(shelf).getByLabelText("Import your own document"),
  ).toBeInTheDocument();
  expect(within(shelf).queryAllByLabelText(/^Use template /u)).toHaveLength(0);
  click(button("Creative brief", shelf));
  expect(
    within(shelf).queryByLabelText("Import your own document"),
  ).not.toBeInTheDocument();
});

test("A late document catalog and later refresh preserve an explicit category choice", async () => {
  mockTemplateChat();
  const release = context.mocks.deferred<void>();
  let title = "Initial document";
  context.mocks.api(userTemplatesContract.list, async ({ respond }) => {
    await release.promise;
    return respond(200, [{ ...template("document"), title }]);
  });
  const { shelf } = await openShelf("Document", "Document templates");
  expect(shelf).toHaveAttribute("aria-busy", "true");
  click(button("Reports", shelf));
  release.resolve();
  // Seeing the document in the picker proves that the pending response has
  // reached the UI before checking that it did not overwrite Reports.
  click(button("More templates", shelf));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Initial document");
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  expect(button("Reports", shelf)).toHaveAttribute("aria-pressed", "true");
  expect(
    within(shelf).queryByLabelText("Import your own document"),
  ).not.toBeInTheDocument();
  click(button("Custom", shelf));
  await within(shelf).findByText("Initial document");
  title = "Newly published document";
  context.mocks.ably.trigger("presentationTemplatesChanged");
  await within(shelf).findByText(title);
  expect(button("Custom", shelf)).toHaveAttribute("aria-pressed", "true");
  expect(within(shelf).queryByText("Initial document")).not.toBeInTheDocument();
});

test("Custom alone enables the Document task and sends the selected custom reference", async () => {
  const { capture, own } = mockShelfCatalog("document");
  const { editor, shelf } = await openShelf(
    "Document",
    "Document templates",
    true,
    "Keep my launch brief",
    false,
  );
  await within(shelf).findByText(own.title);
  expect(button("Custom", shelf)).toHaveAttribute("aria-pressed", "true");
  expect(within(shelf).queryByText("Creative brief")).not.toBeInTheDocument();
  click(button(`Use template ${own.title}`, shelf));
  expect(editor).toHaveTextContent("Keep my launch brief");
  expect(editor).toHaveTextContent(own.title);
  click(button("Send"));
  await waitFor(() => {
    expect(capture.selectedTemplates).toStrictEqual([
      { type: "custom", selection: { userTemplateId: own.id } },
    ]);
  });
});

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
    const { shelf } = await openShelf(
      "Document",
      "Document templates",
      true,
      "",
      false,
    );
    let importSurface = shelf;
    if (entry === "picker") {
      click(button("More templates", shelf));
      importSurface = await screen.findByRole("dialog");
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

test("A failed custom catalog still shows built-in document templates and the import chip", async () => {
  mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Catalog unavailable" },
    });
  });
  const { shelf } = await openShelf("Document", "Document templates");
  await waitFor(() => {
    expect(button("Creative brief", shelf)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  expect(
    within(shelf).getAllByLabelText(/^Use template /u).length,
  ).toBeGreaterThan(0);
  click(button("Custom", shelf));
  expect(
    within(shelf).getByLabelText("Import your own document"),
  ).toBeInTheDocument();
});
