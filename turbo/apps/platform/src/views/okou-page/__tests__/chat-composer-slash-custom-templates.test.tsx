import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  type UserTemplateCatalogEntry,
  userTemplatesContract,
} from "@okouai/api-contracts/contracts/user-templates";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  createTemplateGalleryHelpers,
  expectInlineTemplate,
  THREAD_ID,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const agentChat = "/";

function published(
  kind: UserTemplateCatalogEntry["kind"],
  title: string,
  mine: boolean,
): UserTemplateCatalogEntry & { coverUrl: string } {
  const id = crypto.randomUUID();
  return {
    id,
    kind,
    title,
    sourceFilename:
      title +
      { presentation: ".pptx", illustration: ".png", document: ".docx" }[kind],
    coverUrl: `https://assets.example.test/${id}.png`,
    coverHasMorePages: kind === "presentation",
    pageCount: kind === "presentation" ? 3 : null,
    visibility: mine ? "private" : "organization",
    ownerUserId: mine ? "user_mock" : "user-colleague",
    ownerDisplayName: mine ? "Author" : "Teammate",
    canManage: mine,
    createdAt: "2026-09-04T09:00:00Z",
    updatedAt: "2026-09-04T09:00:00Z",
    previewAssets:
      kind === "illustration"
        ? [
            {
              previewAssetId: `example-${id}`,
              url: `https://assets.example.test/${id}/example.png`,
              expiresAt: "2099-01-01T00:00:00Z",
            },
          ]
        : [],
  };
}

function previewImage(container: HTMLElement, url: string) {
  const image = within(container).getByAltText("");
  expect(image).toHaveAttribute("src", url);
  return image;
}

test.each([
  {
    id: "001",
    path: `/chats/${THREAD_ID}`,
    kind: "presentation",
    category: "Presentation",
    builtin: "Paper magazine",
    brief: "Pitch the autumn collection",
  },
  {
    id: "002",
    path: agentChat,
    kind: "illustration",
    category: "Illustration",
    builtin: "Cozy Parlor",
    brief: "Illustrate a neighborhood map",
  },
  {
    id: "003",
    path: agentChat,
    kind: "document",
    category: "Document",
    builtin: "Simple invoice",
    brief: "Write the studio proposal",
  },
] as const)(
  "chat-composer-slash-custom-templates-$id sends the author's $category selection from the Templates menu",
  async ({ path, kind, category, brief, builtin }) => {
    context.mocks.browser.matchMedia(true);
    const own = published(kind, `My ${category} design`, true);
    const shared = published(kind, `Team ${category} design`, false);
    const unrelated = published(
      kind === "document" ? "presentation" : "document",
      "Other department sample",
      false,
    );
    context.mocks.api(userTemplatesContract.list, ({ respond }) => {
      return respond(200, [unrelated, shared, own]);
    });
    const chat = createTemplateGalleryHelpers(context).mockTemplateChat();
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.SlashActions]: true },
    });
    const editor = await findComposerEditor();
    await fill(editor, brief);
    await userEvent.paste(" /");
    await userEvent.hover(
      await screen.findByText("Templates", { selector: "button span" }),
    );
    const menu = await screen.findByRole("region", { name: "Templates" });
    const choices = within(menu);
    click(choices.getByText(category, { selector: "button" }));
    const select = await choices.findByLabelText(`Use template ${own.title}`);
    expect(
      choices.getByLabelText(`Use template ${shared.title}`),
    ).toBeEnabled();
    expect(choices.getByLabelText(`Use template ${builtin}`)).toBeEnabled();
    expect(
      choices.queryByLabelText(`Use template ${unrelated.title}`),
    ).not.toBeInTheDocument();
    // The illustration option displays a published example; the composer chip uses its cover.
    const target =
      kind === "illustration"
        ? previewImage(select, own.previewAssets[0]!.url)
        : select;
    click(target);

    const attachment = await expectInlineTemplate(own.title);
    const selectedContent =
      kind === "illustration"
        ? previewImage(attachment, own.coverUrl)
        : attachment;
    expect(editor).toContainElement(selectedContent);
    expect(
      within(editor).getByText(brief, { exact: true }),
    ).toBeInTheDocument();
    expect(editor).toHaveFocus();
    expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(chat.sentMessages.at(-1)?.parts).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "template",
            template: { type: "custom", selection: { userTemplateId: own.id } },
          }),
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(brief),
          }),
        ]),
      );
    });
  },
);
