import {
  userTemplatesContract,
  type UserTemplateCatalogEntry,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { DOCUMENT_TEMPLATE_ITEMS } from "@okouai/core/document-template-items";
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
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

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

function startsWithText(element: Element, prefix: string): boolean {
  return (
    element.textContent?.replace(/\s+/gu, " ").trim().startsWith(prefix) ??
    false
  );
}

interface CategoryRow {
  readonly category: string;
  readonly kind: UserTemplateKind;
  readonly builtInTitle: string;
  readonly path: string;
}

/**
 * Opens the Templates slash overview on the category with an own, a shared
 * and an other-kind custom template, and checks what the overview lists.
 */
async function openCategoryOverview({
  category,
  kind,
  builtInTitle,
  path,
}: CategoryRow) {
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
  const otherKind = kind === "presentation" ? "illustration" : "presentation";
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, [own, template(otherKind), shared]);
  });
  context.mocks.browser.matchMedia(true);
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.SlashActions]: true },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Keep my brief /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  const entry = await waitFor(() => {
    const templates = queryAllByRoleFast("button", menu).find((candidate) => {
      return startsWithText(candidate, "Templates ");
    });
    if (!templates) {
      throw new Error("Expected the Templates overview entry");
    }
    return templates;
  });
  await userEvent.setup({ delay: null }).hover(entry);
  const pane = await within(menu).findByRole("region", { name: "Templates" });
  const type = queryAllByRoleFast("button", pane).find((candidate) => {
    return startsWithText(candidate, `${category} `);
  });
  if (!type) {
    throw new Error(`Expected template type ${category}`);
  }
  click(type);
  await waitFor(() => {
    expect(type).toHaveAttribute("aria-pressed", "true");
  });

  await expect(within(pane).findByText(own.title)).resolves.toBeVisible();
  expect(within(pane).getByText(shared.title)).toBeVisible();
  expect(within(pane).getByText(builtInTitle)).toBeVisible();
  expect(
    within(pane).queryByText(template(otherKind).title),
  ).not.toBeInTheDocument();
  return {
    capture,
    editor,
    own,
    cover: button(`Use template ${own.title}`, pane),
  };
}

async function insertAndSend({
  editor,
  own,
  cover,
}: Awaited<ReturnType<typeof openCategoryOverview>>) {
  click(cover);
  await waitFor(() => {
    expect(editor).toHaveTextContent(own.title);
  });
  expect(editor).toHaveTextContent("Keep my brief");
  expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
  expect(editor).toHaveFocus();

  click(button("Send"));
}

test.each([
  {
    category: "Presentation",
    kind: "presentation",
    builtInTitle: PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!.title,
    path: `/chats/${THREAD_ID}`,
  },
  {
    category: "Document",
    kind: "document",
    builtInTitle: DOCUMENT_TEMPLATE_ITEMS[0]!.title,
    path: `/agents/${AGENT_ID}/chat`,
  },
] as const)(
  "The Templates overview's $category type offers accessible custom templates and sends their references",
  async (row) => {
    const overview = await openCategoryOverview(row);

    await insertAndSend(overview);
    await waitFor(() => {
      expect(overview.capture.selectedTemplates).toStrictEqual([
        { type: "custom", selection: { userTemplateId: overview.own.id } },
      ]);
    });
  },
);

test("The Templates overview's Illustration type offers accessible custom templates with their preview image and sends their references", async () => {
  const overview = await openCategoryOverview({
    category: "Illustration",
    kind: "illustration",
    builtInTitle: ILLUSTRATION_TEMPLATE_ITEMS[0]!.title,
    path: `/agents/${AGENT_ID}/chat`,
  });

  expect(overview.cover.querySelector("img")).toHaveAttribute(
    "src",
    overview.own.previewAssets[0]!.url,
  );
  await insertAndSend(overview);
  await waitFor(() => {
    expect(overview.capture.selectedTemplates).toStrictEqual([
      { type: "custom", selection: { userTemplateId: overview.own.id } },
    ]);
  });
});
