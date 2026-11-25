import { findAction } from "./connector-integrations-test-helpers.ts";
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
import {
  findComposerEditor,
  composerWorkflow,
} from "./chat-composer-test-helpers.ts";
import {
  createTemplateGalleryHelpers,
  expectInlineTemplate,
  THREAD_ID,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

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
    category: "Image",
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
  "chat-composer-slash-custom-templates-$id sends the author's $category selection through slash Create",
  async ({ path, kind, category, brief, builtin }) => {
    context.mocks.browser.matchMedia(true);
    const own = published(kind, `My ${category} design`, true);
    const shared = published(kind, `Team ${category} design`, false);
    const unrelated = published(
      kind === "document" ? "presentation" : "document",
      "Other department sample",
      false,
    );
    let available = [unrelated, shared];
    context.mocks.api(userTemplatesContract.list, ({ respond }) => {
      return respond(200, available);
    });
    const chat = createTemplateGalleryHelpers(context).mockTemplateChat();
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.SlashActions]: true },
    });
    const editor = await findComposerEditor();
    await fill(editor, brief + " /create");
    const menu = await screen.findByTestId("slash-workflow-menu");
    click(await within(menu).findByText("Create", { exact: true }));
    const types = await screen.findByRole("radiogroup", { name: "Create" });
    click(await within(types).findByText(category));
    const shelf = await screen.findByRole("group", {
      name: category === "Image" ? "Image styles" : category + " templates",
    });
    const choices = within(shelf);
    await choices.findByText(shared.title);
    expect(choices.queryByText(own.title)).toBeNull();
    available = [unrelated, own];
    context.mocks.ably.trigger("presentationTemplatesChanged");
    await choices.findByText(own.title);
    expect(choices.queryByText(shared.title)).toBeNull();
    expect(choices.getByText(builtin)).toBeVisible();
    expect(choices.queryByText(unrelated.title)).toBeNull();
    const select = await findAction("button", own.title, shelf);
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

async function draft(path = RUN_PATH) {
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(
      200,
      ["weekly-recap", "pr-123-review"].map((name) => {
        return composerWorkflow(name, null);
      }),
    );
  });
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  await setupPage({ context, path });
  const editor = await findComposerEditor();
  await userEvent.click(editor);
  return editor;
}

test("chat-composer-slash-hint-002 the workflow hint follows a bare slash in the existing thread", async () => {
  const editor = await draft();
  await userEvent.keyboard("/");
  await screen.findByTestId("slash-workflow-menu");
  const hint = () => {
    return editor.querySelector("[data-placeholder]");
  };
  expect(hint()).toHaveAttribute("data-placeholder", " choose an action");
  expect(editor).toHaveTextContent(/^\/$/);
  await userEvent.keyboard("week");
  const menu = await screen.findByTestId("slash-workflow-menu");
  expect(hint()).toBeNull();
  click(await findFastControl("button", /weekly-recap/, menu));
  expect(editor).toHaveTextContent("weekly-recap");
  await userEvent.keyboard(" /");
  await screen.findByTestId("slash-workflow-menu");
  const before = editor.textContent;
  expect(hint()).toHaveAttribute("data-placeholder", " choose an action");
  await userEvent.keyboard("{Escape}");
  expect(hint()).toBeNull();
  expect(editor.textContent).toBe(before);
  expect(editor).toHaveFocus();
});

test("The home composer dismisses a second bare slash hint while preserving the accepted workflow", async () => {
  const editor = await draft("/");
  await userEvent.keyboard("/");
  const firstMenu = await screen.findByTestId("slash-workflow-menu");
  expect(editor.textContent).toBe("/");
  expect(editor.querySelector("[data-placeholder]")).toHaveAttribute(
    "data-placeholder",
    " choose an action",
  );
  await userEvent.keyboard("pr");
  const choice = await findFastControl("button", /pr-123-review/, firstMenu);
  expect(editor.querySelector("[data-placeholder]")).toBeNull();
  expect(choice).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(editor).toHaveTextContent("pr-123-review");
  await userEvent.keyboard(" /");
  await screen.findByTestId("slash-workflow-menu");
  const accepted = editor.textContent;
  expect(editor.querySelector("[data-placeholder]")).toHaveAttribute(
    "data-placeholder",
    " choose an action",
  );
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  expect(editor.querySelector("[data-placeholder]")).toBeNull();
  expect(editor.textContent).toBe(accepted);
  expect(editor).toHaveFocus();
});

test("A home workflow inserted at the beginning keeps the numbered suffix after its hint", async () => {
  const editor = await draft("/");
  await userEvent.keyboard(" 131");
  expect(editor.textContent).toBe(" 131");
  const cursor = window.getSelection();
  cursor?.collapse(editor.querySelector("p")?.firstChild ?? editor, 0);
  await userEvent.keyboard("/");
  const panel = await screen.findByTestId("slash-workflow-menu");
  const hint = editor.querySelector("[data-placeholder]");
  expect(hint).toHaveAttribute("data-placeholder", " choose an action");
  expect(hint?.textContent).toBe("/");
  expect(hint?.nextSibling?.textContent).toBe(" 131");
  expect(editor.textContent).toBe("/ 131");
  await userEvent.keyboard("week");
  expect(editor.textContent).toBe("/week 131");
  click(await findFastControl("button", /weekly-recap/, panel));
  expect(editor).toHaveTextContent("weekly-recap");
  expect(editor.textContent).toBe("/weekly-recap 131");
});
