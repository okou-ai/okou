import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { HttpResponse } from "msw";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { uploadsContract } from "@okouai/api-contracts";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createTemplateGalleryHelpers } from "./chat-composer-template-gallery-test-helpers.ts";
import { THREAD_ID, findComposerEditor } from "./chat-composer-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

const UPLOAD_URL = "https://uploads.test.okou.ai/composer-add-menu";

async function setupComposer(): Promise<HTMLElement> {
  mockTemplateChat();
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    return respond(200, {
      id: "f1000000-0000-4000-a000-000000000201",
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url: `${UPLOAD_URL}/${body.filename}`,
      uploadUrl: UPLOAD_URL,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(UPLOAD_URL, () => {
    return new HttpResponse(null, { status: 200 });
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  return await findComposerEditor();
}

function composerCard(editor: HTMLElement): HTMLElement {
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected composer card");
  }
  return card;
}

async function openAddMenu(editor: HTMLElement): Promise<HTMLElement> {
  click(within(composerCard(editor)).getByLabelText("Add"));
  return await screen.findByRole("menu", { name: "Add" });
}

function menuItemLabels(menu: HTMLElement): string[] {
  return queryAllByRoleFast("menuitem", menu).map((item) => {
    return item.textContent?.trim() ?? "";
  });
}

function menuItem(menu: HTMLElement, label: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === label;
  });
  if (!item) {
    throw new Error(`Expected the ${label} row`);
  }
  return item;
}

test("groups attach, template and import skills actions in the add menu", async () => {
  const editor = await setupComposer();
  const menu = await openAddMenu(editor);
  expect(menuItemLabels(menu)).toStrictEqual([
    "Attach",
    "Template",
    "Import skills",
  ]);
});

test("opens the import skills dialog from the add menu", async () => {
  const editor = await setupComposer();

  const menu = await openAddMenu(editor);
  expect(menuItemLabels(menu)).toStrictEqual([
    "Attach",
    "Template",
    "Import skills",
  ]);
  click(menuItem(menu, "Import skills"));

  const dialog = await screen.findByRole("dialog", {
    name: "Import your skills",
  });
  // The dialog is ready once its prompt can be copied.
  await waitFor(() => {
    expect(
      queryAllByRoleFast("button", dialog).find((button) => {
        return button.textContent?.trim() === "Copy prompt";
      }),
    ).toBeVisible();
  });

  const viewWorkflows = queryAllByRoleFast("link", dialog).find((link) => {
    return link.textContent?.trim() === "View workflows";
  });
  if (!viewWorkflows) {
    throw new Error("Expected the View workflows link");
  }
  click(viewWorkflows);
  await waitFor(() => {
    expect(pathname()).toBe("/workflows");
  });
  expect(
    screen.queryByRole("dialog", { name: "Import your skills" }),
  ).toBeNull();
});

test("opens the template picker from the add menu", async () => {
  const editor = await setupComposer();
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template fixture");
  }

  const menu = await openAddMenu(editor);
  click(menuItem(menu, "Template"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  await expect(
    screen.findByLabelText(`Select template ${template.title}`),
  ).resolves.toBeVisible();
});

// Happy DOM has no native picker. Stub that browser boundary here; native
// pointer/keyboard activation needs Chromium on the deployed preview.
// Selection must still attach the file after the menu has closed.
test("attaches the chosen file from the attach row", async () => {
  const editor = await setupComposer();
  const menu = await openAddMenu(editor);
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Expected the composer file input");
  }
  Object.defineProperty(input, "showPicker", { value: vi.fn<() => void>() });

  click(menuItem(menu, "Attach"));
  await waitFor(() => {
    expect(screen.queryByRole("menu", { name: "Add" })).not.toBeInTheDocument();
  });

  fireEvent.change(input, {
    target: {
      files: [new File(["launch brief"], "brief.txt", { type: "text/plain" })],
    },
  });

  await expect(screen.findByText("brief.txt")).resolves.toBeInTheDocument();
  await expect(
    screen.findByLabelText("Remove brief.txt"),
  ).resolves.toBeInTheDocument();
});
