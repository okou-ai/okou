import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import {
  userTemplatesContract,
  type UserTemplateCatalogEntry,
} from "@okouai/api-contracts/contracts/user-templates";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createTemplateGalleryHelpers,
  THREAD_ID,
  openTemplatePicker,
  expectInlineTemplate,
  sendComposerMessage,
} from "./chat-composer-template-gallery-test-helpers.ts";
const context = testContext();
const api = "https://library.example.test/";
type Category = "Document" | "Presentation" | "Image";
function entry(
  slot: number,
  title: string,
  kind: UserTemplateCatalogEntry["kind"],
  sourceFilename: string,
): UserTemplateCatalogEntry {
  return {
    id: "6a790000-0000-4000-a000-" + String(slot).padStart(12, "0"),
    title,
    kind,
    sourceFilename,
    coverUrl: api + slot + ".png",
    coverHasMorePages: true,
    pageCount: kind === "presentation" ? 2 : null,
    visibility: "private",
    ownerUserId: "user_test",
    ownerDisplayName: "Avery",
    canManage: true,
    createdAt: "2026-08-02T10:00:00Z",
    updatedAt: "2026-08-02T10:00:00Z",
    previewAssets: [],
  };
}
const board = entry(1, "Q3 board review", "presentation", "Board.pptx");
const brand = entry(2, "Brand report", "document", "Report.docx");
const quiet = entry(3, "Quiet UI mockup", "illustration", "Source.png");
const next = entry(4, "Renewal style", "illustration", "Renewal.png");
const pages = Object.freeze([api + "a.png", api + "b.png"]);
async function library(
  category: Category,
  options: {
    entries?: UserTemplateCatalogEntry[];
    fail?: "list" | "edit";
  } = {},
) {
  let rows = options.entries ?? [board, brand, quiet, next];
  const chat = createTemplateGalleryHelpers(context).mockTemplateChat();
  const failed = {
    error: { code: "REQUEST_FAILED", message: "Library refused this change" },
  };
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return options.fail === "list" ? respond(500, failed) : respond(200, rows);
  });
  context.mocks.api(userTemplatesContract.get, ({ params, respond }) => {
    const row = rows.find((x) => {
      return x.id === params.templateId;
    });
    if (!row) {
      return respond(404, failed);
    }
    return respond(200, {
      ...row,
      pageUrls: row.kind === "presentation" ? [...pages] : [],
      sourceUrl: api + row.sourceFilename,
    });
  });
  context.mocks.api(
    userTemplatesContract.update,
    ({ params, body, respond }) => {
      const row = rows.find((x) => {
        return x.id === params.templateId;
      });
      if (!row || options.fail === "edit") {
        return respond(500, failed);
      }
      const updated = { ...row, ...body };
      rows = rows.map((x) => {
        return x.id === updated.id ? updated : x;
      });
      return respond(200, updated);
    },
  );
  context.mocks.api(userTemplatesContract.delete, ({ params, respond }) => {
    rows = rows.filter((x) => {
      return x.id !== params.templateId;
    });
    return respond(204);
  });
  await setupPage({ context, path: "/chats/" + THREAD_ID });
  const user = userEvent.setup({ delay: null });
  const picker = await openTemplatePicker(user);
  click(await findFastControl("tab", category, picker));
  return { picker, user, chat };
}
const button = (root: HTMLElement, name: string | RegExp) => {
  return findFastControl("button", name, root);
};
function menuAction(role: "menuitem" | "menuitemradio", name: string) {
  return waitFor(() => {
    const item = queryAllByRoleFast(role).find((el) => {
      return (el.getAttribute("aria-label") ?? el.textContent?.trim()) === name;
    });
    if (!item) {
      throw new Error("Missing menu action " + name);
    }
    return item;
  });
}
async function preview(picker: HTMLElement, title: string) {
  click(await button(picker, "Preview " + title));
}
function selected(picker: HTMLElement, name: Category) {
  expect(queryFastControl("tab", name, picker)).toHaveAttribute(
    "aria-selected",
    "true",
  );
}
test("chat-composer-custom-templates-013 A document without a cover shows its file type", async () => {
  const { picker } = await library("Document", {
    entries: [{ ...brand, coverUrl: null, coverHasMorePages: false }],
  });
  const cover = await button(picker, "Preview Brand report");
  expect(within(cover).getByText("DOCX")).toBeInTheDocument();
  expect(cover.querySelector("img")).toBeNull();
});
test("chat-composer-custom-templates-014 A multi-page report shows its cover and stacked sheets", async () => {
  const { picker } = await library("Document");
  const cover = await button(picker, "Preview Brand report");
  expect(cover.querySelector("img")).toHaveAttribute("src", brand.coverUrl);
  expect(within(cover).queryByText("DOCX")).toBeNull();
  expect(within(cover).getAllByTestId("document-cover-sheet")).toHaveLength(2);
});
async function openDocument(filename: string) {
  const { picker } = await library("Document", {
    entries: [{ ...brand, sourceFilename: filename }],
  });
  await preview(picker, brand.title);
  const frame = await screen.findByTestId("custom-template-source-preview");
  return {
    picker,
    url: new URL(frame.getAttribute("src") ?? "", location.origin),
  };
}
test("chat-composer-custom-templates-015 The Office viewer receives the DOCX source and keeps template actions available", async () => {
  const { picker, url } = await openDocument("Report.docx");
  expect(url.hostname).toBe("view.officeapps.live.com");
  expect(url.searchParams.get("src")).toBe(api + "Report.docx");
  await expect(
    screen.findByRole("textbox", { name: "Rename template" }),
  ).resolves.toHaveValue(brand.title);
  await expect(
    button(document.body, "Use this template"),
  ).resolves.toBeInTheDocument();
  expect(within(picker).getByText(brand.title)).toBeVisible();
});
test("chat-composer-custom-templates-016 The PDF viewer receives the source with the embedded reading options", async () => {
  const { url } = await openDocument("Report.pdf");
  expect(url.href).toBe(api + "Report.pdf#toolbar=0&navpanes=0&view=FitH");
});
test("chat-composer-custom-templates-010 The board template presents both slides and stops at the end", async () => {
  const { picker } = await library("Presentation");
  await preview(picker, board.title);
  await expect(screen.findByAltText("Page 1")).resolves.toHaveAttribute(
    "src",
    pages[0],
  );
  await screen.findByText("1 / 2");
  await screen.findByText("2 slides");
  const forward = await button(document.body, /next (page|slide)/i);
  click(forward);
  await expect(screen.findByAltText("Page 2")).resolves.toHaveAttribute(
    "src",
    pages[1],
  );
  await screen.findByText("2 / 2");
  expect(forward).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Rename template" })).toHaveValue(
    board.title,
  );
  expect(queryFastControl("button", "Use this template")).toBeInTheDocument();
  expect(screen.queryByTestId("custom-template-source-preview")).toBeNull();
});
async function renameImage(title: string, fail?: "edit") {
  const { picker } = await library("Image", { fail });
  click(await button(picker, "Actions for Quiet UI mockup"));
  click(await menuAction("menuitem", "Rename"));
  const field = await screen.findByRole("textbox", { name: /rename/i });
  await fill(field, title);
  click(await button(document.body, "Save"));
  return { picker, field };
}
test("chat-composer-custom-templates-019 The illustration card takes its trimmed title and stays in Image", async () => {
  const { picker, field } = await renameImage(" Quiet UI kit ");
  await within(picker).findByText("Quiet UI kit");
  expect(field).not.toBeInTheDocument();
  selected(picker, "Image");
});
test("chat-composer-custom-templates-020 Refusing the rename preserves both the rejected edit and the existing card", async () => {
  const { picker, field } = await renameImage("Quiet UI kit", "edit");
  await screen.findByText("Couldn't rename the template.");
  expect(field).toHaveValue("Quiet UI kit");
  expect(within(picker).getByText(quiet.title)).toBeInTheDocument();
});
async function editBoard(value: string) {
  const { picker, user } = await library("Presentation");
  await preview(picker, board.title);
  const field = await screen.findByRole("textbox", { name: "Rename template" });
  await fill(field, value);
  return { picker, user, field };
}
test("chat-composer-custom-templates-022 Leaving the title field saves its normalized text in the catalog", async () => {
  const { picker, field } = await editBoard(" Board  review   FY26 ");
  fireEvent.blur(field);
  await within(picker).findByText("Board review FY26");
  expect(within(picker).queryByText(board.title)).toBeNull();
});
test("chat-composer-custom-templates-023 IME Enter preserves the pending title until composition is committed", async () => {
  const value = " 季度   报告 ";
  const { picker, user, field } = await editBoard(value);
  fireEvent.compositionStart(field);
  fireEvent.keyDown(field, { key: "Enter", isComposing: true, keyCode: 229 });
  expect(field).toHaveFocus();
  expect(field).toBeEnabled();
  expect(field).toHaveValue(value);
  expect(within(picker).getByText(board.title)).toBeInTheDocument();
  fireEvent.compositionEnd(field);
  await user.keyboard("{Enter}");
  await within(picker).findByText("季度 报告");
  expect(within(picker).queryByText(board.title)).toBeNull();
});
test("chat-composer-custom-templates-036 A failed custom catalog leaves deck import and the built-in shelf available", async () => {
  const { picker } = await library("Presentation", { fail: "list" });
  const custom = await within(picker).findByRole("region", { name: "Custom" });
  await within(custom).findByText("Couldn't load templates.");
  expect(within(custom).getByLabelText("Import your own deck")).toBeEnabled();
  expect(
    within(picker).getByRole("region", { name: "Built-in" }),
  ).toBeInTheDocument();
});
test("chat-composer-custom-templates-006 Changing catalog category resets the search and scopes the available templates", async () => {
  const { picker } = await library("Presentation", {
    entries: [
      board,
      { ...brand, sourceFilename: "brand-report.docx" },
      quiet,
      next,
    ],
  });
  const shelf = () => {
    return within(picker).getByRole("region", { name: "Custom" });
  };
  async function only(present: string, absent: readonly string[]) {
    await within(shelf()).findByText(present);
    for (const title of absent) {
      expect(within(shelf()).queryByText(title)).toBeNull();
    }
  }
  await only(board.title, [brand.title, quiet.title]);
  click(await findFastControl("tab", "Document", picker));
  await only(brand.title, [board.title, quiet.title]);
  click(await findFastControl("tab", "Image", picker));
  await only(quiet.title, [brand.title, board.title]);
  const search = within(picker).getByRole("textbox");
  await fill(search, "brand-report.docx");
  await within(picker).findByText("No matches");
  expect(within(picker).queryByText(quiet.title)).toBeNull();
  click(await findFastControl("tab", "Document", picker));
  await only(brand.title, [board.title, quiet.title]);
  expect(within(picker).getByRole("textbox")).toHaveValue("");
});
test("chat-composer-custom-templates-009 Returning from Website keeps the loaded presentation searchable while catalog responses are withheld", async () => {
  const { picker } = await library("Presentation");
  await button(picker, "Preview Q3 board review");
  const gate = context.mocks.deferred<void>();
  context.mocks.api(userTemplatesContract.list, async ({ respond }) => {
    await gate.promise;
    return respond(200, []);
  });
  try {
    click(await findFastControl("tab", "Website", picker));
    expect(within(picker).queryByText(board.title)).toBeNull();
    click(await findFastControl("tab", "Presentation", picker));
    await button(picker, "Preview Q3 board review");
    expect(within(picker).getByRole("textbox")).toBeEnabled();
  } finally {
    gate.resolve();
  }
});
test("chat-composer-custom-templates-012 Using a board template carries its cover into the composer and sends its row identifier", async () => {
  const { picker, chat, user } = await library("Presentation");
  const tile = (await button(picker, "Preview Q3 board review")).parentElement;
  if (!tile) {
    throw new Error("Missing board template tile");
  }
  click(await button(tile, /Use/));
  const chip = await expectInlineTemplate(board.title);
  expect(chip.querySelector("img")).toHaveAttribute("src", board.coverUrl);
  expect(picker).not.toBeInTheDocument();
  await sendComposerMessage(user, "Prepare my board review");
  await screen.findByText("Prepare my board review", { exact: false });
  await waitFor(() => {
    return expect(chat.selectedTemplates).toStrictEqual([
      { type: "custom", selection: { userTemplateId: board.id } },
    ]);
  });
});
test("chat-composer-custom-templates-017 Selecting examples cycles the illustration preview without displaying the source", async () => {
  const examples = [
    api + "variant-one.png",
    api + "variant-two.png",
    api + "variant-three.png",
  ];
  const row = {
    ...quiet,
    previewAssets: examples.map((url, i) => {
      return {
        previewAssetId: "example-" + i,
        url,
        expiresAt: "2099-03-01T00:00:00Z",
      };
    }),
  };
  const { picker } = await library("Image", { entries: [row] });
  const image = await within(picker).findByAltText(
    "Quiet UI mockup illustration preview",
  );
  expect(image).toHaveAttribute("src", examples[0]);
  const tile = image.closest<HTMLElement>("[data-custom-illustration-card]");
  if (!tile) {
    throw new Error("Missing illustration card");
  }
  click(await button(tile, "Show variant 2"));
  expect(image).toHaveAttribute("src", examples[1]);
  click(image);
  expect(image).toHaveAttribute("src", examples[2]);
  expect(image).not.toHaveAttribute("src", api + quiet.sourceFilename);
});
async function shareBoard(fail?: "edit") {
  const { picker } = await library("Presentation", { fail });
  await preview(picker, board.title);
  const trigger = await button(document.body, /Change template visibility/);
  click(trigger);
  click(await menuAction("menuitemradio", "Organization"));
  return { picker, trigger };
}
test("chat-composer-custom-templates-026 Sharing a private board updates the catalog audience", async () => {
  const { picker, trigger } = await shareBoard();
  await waitFor(() => {
    return expect(trigger).toHaveTextContent("Organization");
  });
  click(await button(document.body, "Custom templates"));
  const shelf = within(picker).getByRole("region", { name: "Custom" });
  await within(shelf).findByText("Organization");
  expect(within(shelf).queryByText("Private")).toBeNull();
});
test("chat-composer-custom-templates-030 A rejected sharing change keeps the owner's private explanation", async () => {
  const { trigger } = await shareBoard("edit");
  await screen.findByText("Library refused this change");
  expect(screen.getByRole("textbox", { name: "Rename template" })).toHaveValue(
    board.title,
  );
  expect(trigger).toHaveTextContent("Private");
  expect(trigger).toHaveTextContent("Only you can see and use it");
});
test("chat-composer-custom-templates-027 Deleting one illustration leaves the second in the selected category", async () => {
  const { picker } = await library("Image");
  await within(picker).findByText(next.title);
  click(await button(picker, "Actions for Quiet UI mockup"));
  click(await menuAction("menuitem", "Delete"));
  click(await button(document.body, "Delete template"));
  await waitFor(() => {
    return expect(within(picker).queryByText(quiet.title)).toBeNull();
  });
  expect(within(picker).getByText(next.title)).toBeInTheDocument();
  selected(picker, "Image");
});
test("chat-composer-custom-templates-033 Importing a document sends its analysis request and the publication guidance", async () => {
  const { picker, chat, user } = await library("Document");
  const filename = "Strategy.docx";
  const type =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const file = new File(["meeting notes"], filename, { type });
  context.mocks.upload.success({
    id: "ae790011-0000-4000-a000-000000000001",
    filename,
    contentType: type,
    size: file.size,
    url: api + filename,
  });
  await user.upload(
    within(picker).getByLabelText("Import your own document"),
    file,
  );
  await waitFor(() => {
    return expect(chat.sentMessages).toHaveLength(1);
  });
  const parts = chat.sentMessages[0]!.parts;
  expect(parts).toContainEqual({
    type: "text",
    text: "Analyse this file and save it as a reusable template.",
  });
  const guidance = parts.find((p) => {
    return p.type === "additional_info";
  })?.text;
  expect(guidance).toContain("extract-template");
  expect(guidance).toContain("okou-ai/okou-skills");
  expect(guidance).toMatch(/branch.*this file/i);
  expect(guidance).toMatch(/publish.*--kind.*branch.*Custom/i);
});
