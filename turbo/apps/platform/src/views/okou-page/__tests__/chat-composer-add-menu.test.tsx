import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createTemplateGalleryHelpers } from "./chat-composer-template-gallery-test-helpers.ts";
import { findComposerEditor, THREAD_ID } from "./chat-composer-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

const UPLOAD_URL = "https://uploads.test.okou.ai/composer-add-menu";

async function openAddMenu(): Promise<HTMLElement> {
  mockTemplateChat();
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  const editor = await findComposerEditor();
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected composer card");
  }
  click(within(card).getByLabelText("Add"));
  return await screen.findByRole("menu", { name: "Add" });
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

test("Import skills opens its dialog and View workflows leaves it for the workflows page", async () => {
  const menu = await openAddMenu();

  click(menuItem(menu, "Import skills"));
  const dialog = await screen.findByRole("dialog", {
    name: "Import your skills",
  });
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
    expect(window.location.pathname).toBe("/workflows");
  });
  expect(
    screen.queryByRole("dialog", { name: "Import your skills" }),
  ).toBeNull();
});

// Happy DOM has no native picker, so the file input's showPicker is stubbed at
// that browser boundary; the selected file must still attach after the menu closes.
test("The Attach row attaches the file chosen after the menu closes", async () => {
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
  const menu = await openAddMenu();
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Expected the composer file input");
  }
  const showPicker = vi.fn<() => void>();
  Object.defineProperty(input, "showPicker", { value: showPicker });

  click(menuItem(menu, "Attach"));
  await waitFor(() => {
    expect(screen.queryByRole("menu", { name: "Add" })).not.toBeInTheDocument();
  });
  expect(showPicker).toHaveBeenCalledOnce();
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
