import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  captureTemplateSubmission,
  deck,
} from "./template-submission-fixtures.ts";
import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { DOCUMENT_TEMPLATE_ITEMS } from "@okouai/core/document-template-items";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
const context = testContext();

function catalog() {
  const kinds = ["presentation", "illustration", "document"] as const;
  const entries = kinds.flatMap((kind) => {
    return (["private", "organization"] as const).map((visibility) => {
      const own = visibility === "private";
      return {
        id: crypto.randomUUID(),
        title: (own ? "My " : "Team ") + kind,
        sourceFilename: kind + ".png",
        kind,
        coverUrl:
          "https://media.example.org/" + kind + "-" + visibility + ".png",
        coverHasMorePages: false,
        pageCount: kind === "presentation" ? 1 : null,
        visibility,
        ownerUserId: own ? "test-user-123" : "workspace-colleague",
        ownerDisplayName: own ? "Test User" : "Lee",
        canManage: own,
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
        previewAssets: [],
      };
    });
  });
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, entries);
  });
  return entries;
}
const choices = [
  [
    "Presentation",
    "presentation",
    "Presentation templates",
    "Import your own deck",
    deck.title,
  ],
  [
    "Image",
    "illustration",
    "Image styles",
    "Import your own",
    ILLUSTRATION_TEMPLATE_ITEMS[0].title,
  ],
  [
    "Document",
    "document",
    "Document templates",
    "Import your own document",
    DOCUMENT_TEMPLATE_ITEMS[0].title,
  ],
] as const;
test.each([
  ["composer-custom-template-recommendations-001", choices[0]],
  ["composer-custom-template-recommendations-002", choices[1]],
  ["composer-custom-template-recommendations-003", choices[2]],
] as const)(
  "%s the shelf orders and sends an accessible personal template",
  async (_id, [task, kind, label, importLabel, builtIn]) => {
    const entries = catalog();
    const sent = captureTemplateSubmission(context);
    const brief = "Plan the summer review";
    await setupPage({ context, path: "/" });
    const editor = await screen.findByLabelText("Message");
    await fill(editor, brief);
    click(await findAction("button", task));
    const shelf = await screen.findByRole("group", { name: label });
    const input = await within(shelf).findByLabelText(importLabel, {
      selector: "input",
    });
    const standard = await findAction("button", builtIn, shelf);
    const personal = await findAction("button", "My " + kind, shelf);
    const shared = await findAction("button", "Team " + kind, shelf);
    for (const item of [personal, shared]) {
      expect(
        input.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        item.compareDocumentPosition(standard) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    click(personal);
    await waitFor(() => {
      return expect(editor).toHaveTextContent("My " + kind);
    });
    click(await findAction("button", "Send"));
    const parts = (await sent.promise).userMessage?.parts;
    expect(parts).toContainEqual({ type: "text", text: brief });
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "template",
        template: {
          type: "custom",
          selection: {
            userTemplateId: entries.find((e) => {
              return e.title === "My " + kind;
            })?.id,
          },
        },
      }),
    );
  },
);
test("composer-custom-template-recommendations-004 presentation shelf filters the mixed catalog and renders its custom cover", async () => {
  const entries = catalog();
  await setupPage({ context, path: "/" });
  click(await findAction("button", "Presentation"));
  const shelf = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  const own = await findAction("button", "My presentation", shelf);
  expect(own.querySelector("img")).toHaveAttribute("src", entries[0].coverUrl);
  await expect(
    findAction("button", "Team presentation", shelf),
  ).resolves.toBeVisible();
  await expect(findAction("button", deck.title, shelf)).resolves.toBeVisible();
  for (const other of entries.filter((e) => {
    return e.kind !== "presentation";
  })) {
    expect(queryAction("button", other.title, shelf)).toBeNull();
  }
});
test.each([
  ["composer-custom-template-recommendations-006", "Image", choices[0]],
  ["composer-custom-template-recommendations-007", "Presentation", choices[1]],
  ["composer-custom-template-recommendations-008", "Presentation", choices[2]],
] as const)(
  "%s choosing another gallery category updates the submitted creation task",
  async (_id, initial, [task, kind]) => {
    const entries = catalog();
    const item = entries.find((e) => {
      return e.kind === kind;
    })!;
    const sent = captureTemplateSubmission(context);
    await setupPage({ context, path: "/" });
    const editor = await screen.findByLabelText("Message");
    await fill(editor, "Prepare the briefing");
    click(await findAction("button", initial));
    click(await findAction("button", "View all"));
    const gallery = await screen.findByRole("dialog");
    click(await within(gallery).findByRole("combobox"));
    click(await screen.findByRole("option", { name: task }));
    const name = await within(gallery).findByText(item.title, { exact: true });
    let card: HTMLElement | null = name;
    while (card && !queryAction("button", "Use", card)) {
      card = card.parentElement;
    }
    if (!card) {
      throw new Error("No Use action for " + item.title);
    }
    click(await findAction("button", "Use", card));
    await waitFor(() => {
      return expect(editor).toHaveTextContent(item.title);
    });
    expect(editor).toHaveTextContent("Prepare the briefing");
    expect(screen.queryByRole("dialog")).toBeNull();
    await expect(findAction("button", "Remove " + task)).resolves.toBeVisible();
    click(await findAction("button", "Send"));
    const parts = (await sent.promise).userMessage?.parts;
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "template",
        template: { type: "custom", selection: { userTemplateId: item.id } },
      }),
    );
    expect(parts).toContainEqual({
      type: "text",
      text: "Prepare the briefing",
    });
    expect(
      parts?.find((p) => {
        return p.type === "additional_info";
      })?.text,
    ).toContain(
      "Create " +
        (task === "Image" ? "an image" : "a " + task.toLowerCase()) +
        ".",
    );
  },
);
