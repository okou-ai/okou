import {
  userTemplatesContract,
  type UserTemplateCatalogEntry,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { DOCUMENT_TEMPLATE_ITEMS } from "@okouai/core/document-template-items";
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
import { findComposerEditor, tabByText } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  context,
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
    coverUrl: kind === "document" ? null : `https://example.test/${kind}.png`,
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

async function openSlashMenu(
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {},
  path = `/agents/${AGENT_ID}/chat`,
) {
  await setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: true,
      [FeatureSwitchKey.BuiltinDocumentTemplates]: false,
      ...featureSwitches,
    },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Keep my brief /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  return { editor, menu };
}

const CATEGORIES = [
  {
    category: "Presentation",
    kind: "presentation",
    builtInTitle: PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!.title,
    builtInCount: 1,
    path: `/chats/${THREAD_ID}`,
  },
  {
    category: "Illustration",
    kind: "illustration",
    builtInTitle: ILLUSTRATION_TEMPLATE_ITEMS[0]!.title,
    builtInCount: 1,
    path: `/agents/${AGENT_ID}/chat`,
  },
  {
    category: "Document",
    kind: "document",
    builtInTitle: DOCUMENT_TEMPLATE_ITEMS[0]!.title,
    builtInCount: 0,
    path: `/agents/${AGENT_ID}/chat`,
  },
] as const;

test.each(CATEGORIES)(
  "$category offers accessible custom templates and sends their custom references",
  async ({ category, kind, builtInTitle, builtInCount, path }) => {
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
    const { menu, editor } = await openSlashMenu({}, path);
    await userEvent.setup().hover(button(category, menu));
    const pane = await within(menu).findByRole("region", { name: category });
    await within(pane).findByText(own.title);
    expect(within(pane).getByText(shared.title)).toBeInTheDocument();
    expect(within(pane).queryAllByText(builtInTitle)).toHaveLength(
      builtInCount,
    );
    const otherKind = kind === "presentation" ? "illustration" : "presentation";
    expect(
      within(pane).queryByText(template(otherKind).title),
    ).not.toBeInTheDocument();
    const cover = button(`Use template ${own.title}`, pane);
    expect(cover.querySelector("img")?.getAttribute("src") ?? null).toBe(
      kind === "illustration" ? own.previewAssets[0]!.url : own.coverUrl,
    );
    click(cover);
    await waitFor(() => {
      expect(editor).toHaveTextContent(own.title);
    });
    expect(editor).toHaveTextContent("Keep my brief");
    expect(editor).not.toHaveTextContent("/");
    expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
    click(button("Send"));
    await waitFor(() => {
      expect(capture.selectedTemplates).toStrictEqual([
        { type: "custom", selection: { userTemplateId: own.id } },
      ]);
    });
  },
);

test("Disabling custom templates preserves the built-in slash catalog", async () => {
  mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, () => {
    throw new Error("A disabled slash custom catalog must not be requested");
  });
  const { menu } = await openSlashMenu({
    [FeatureSwitchKey.CustomTemplates]: false,
  });
  await userEvent.setup().hover(button("Presentation", menu));
  const pane = await within(menu).findByRole("region", {
    name: "Presentation",
  });
  expect(
    within(pane).getByText(PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!.title),
  ).toBeInTheDocument();
  expect(
    within(pane).queryByText(template("presentation").title),
  ).not.toBeInTheDocument();
  expect(within(menu).queryByText("Document")).not.toBeInTheDocument();
});

test("The Document row opens custom documents when built-in documents are disabled", async () => {
  mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, [template("presentation"), template("document")]);
  });
  const { menu } = await openSlashMenu();
  click(button("Document", menu));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(template("document").title);
  expect(tabByText("Custom")).toHaveAttribute("aria-selected", "true");
  expect(
    within(dialog).queryByText(template("presentation").title),
  ).not.toBeInTheDocument();
});

test("Custom documents appear alongside enabled built-in documents", async () => {
  mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, [template("document")]);
  });
  const { menu } = await openSlashMenu({
    [FeatureSwitchKey.BuiltinDocumentTemplates]: true,
  });
  await userEvent.setup().hover(button("Document", menu));
  const pane = await within(menu).findByRole("region", { name: "Document" });
  await within(pane).findByText(template("document").title);
  expect(
    within(pane).getByText(DOCUMENT_TEMPLATE_ITEMS[0]!.title),
  ).toBeInTheDocument();
});

test("The open slash pane refreshes published and removed templates", async () => {
  mockTemplateChat();
  let catalog = [template("presentation")];
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, catalog);
  });
  const { menu } = await openSlashMenu();
  await userEvent.setup().hover(button("Presentation", menu));
  const pane = await within(menu).findByRole("region", {
    name: "Presentation",
  });
  await within(pane).findByText(template("presentation").title);
  catalog = [
    { ...template("presentation"), title: "Newly published template" },
  ];
  context.mocks.ably.trigger("presentationTemplatesChanged");
  await within(pane).findByText("Newly published template");
  expect(
    within(pane).queryByText(template("presentation").title),
  ).not.toBeInTheDocument();
});

test("A failed custom catalog can be retried without hiding built-in templates", async () => {
  mockTemplateChat();
  let failed = true;
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return failed
      ? respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Unavailable" },
        })
      : respond(200, [template("presentation")]);
  });
  const { menu } = await openSlashMenu();
  await userEvent.setup().hover(button("Presentation", menu));
  const pane = await within(menu).findByRole("region", {
    name: "Presentation",
  });
  await within(pane).findByText("Couldn't load templates.");
  expect(
    within(pane).getByText(PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!.title),
  ).toBeInTheDocument();
  failed = false;
  click(button("Try again", pane));
  await within(pane).findByText(template("presentation").title);
  expect(
    within(pane).queryByText("Couldn't load templates."),
  ).not.toBeInTheDocument();
});
