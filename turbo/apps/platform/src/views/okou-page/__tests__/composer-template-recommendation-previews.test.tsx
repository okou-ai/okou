import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import {
  userTemplatesContract,
  type UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { test, expect } from "vitest";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChatRunFixtures } from "./chat-run-test-fixtures.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
const context = testContext();
const title = "Candy charts";
function servePresentationSlides(slides: number) {
  const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((i) => {
    return i.title === title;
  })!;
  const pages = Array.from({ length: slides }, (_, i) => {
    return "<section data-slide><h1>Quarter " + (i + 1) + "</h1></section>";
  }).join("");
  context.mocks.http.get(item.embedUrl, () => {
    return HttpResponse.html("<html><body>" + pages + "</body></html>");
  });
  return item;
}

async function openPresentationShelfWithDraft() {
  const submitted = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    onSendRequest: (body) => {
      return submitted.resolve(body.userMessage);
    },
  });
  await setupPage({ context, host: "app.okou.ai", path: "/" });
  const editor = await screen.findByLabelText("Message");
  await userEvent.click(await findAction("button", "Presentation"));
  await screen.findByRole("group", { name: "Presentation templates" });
  await fill(editor, "Quarterly review");
  return { editor, submitted };
}

function previewControl(name: string) {
  return findAction("button", "Preview template " + name);
}

function serveCustomPresentation() {
  const id = crypto.randomUUID();
  const pages = [
    "https://files.example.org/atlas-1.png",
    "https://files.example.org/atlas-2.png",
  ];
  const details: UserTemplateDetail = {
    id,
    title: "Research atlas",
    sourceFilename: "atlas.pptx",
    kind: "presentation",
    coverUrl: pages[0],
    coverHasMorePages: true,
    pageCount: 2,
    visibility: "private",
    ownerUserId: "test-user-123",
    ownerDisplayName: "Workspace member",
    canManage: true,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-02T00:00:00Z",
    pageUrls: pages,
    sourceUrl: "https://files.example.org/atlas.pptx",
    previewAssets: [],
  };
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, [details]);
  });
  context.mocks.api(userTemplatesContract.get, ({ respond }) => {
    return respond(200, details);
  });
  return details;
}

test("composer-template-recommendation-previews-001 the themed second slide attaches to the existing draft and is sent", async () => {
  const item = servePresentationSlides(3);
  const { editor, submitted } = await openPresentationShelfWithDraft();
  await userEvent.click(await previewControl(title));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(
    await findAction("button", "Preview next slide", dialog),
  );
  await within(dialog).findByText("2 / 3");
  await userEvent.click(await findAction("button", "Deep dive", dialog));
  await expect(
    findAction("button", "Deep dive", dialog),
  ).resolves.toHaveAttribute("aria-pressed", "true");
  expect(editor).toHaveTextContent(/^Quarterly review$/);
  await userEvent.click(
    await findAction("button", "Use this template", dialog),
  );
  await waitFor(() => {
    return expect(editor).toHaveFocus();
  });
  expect(editor).toHaveTextContent("Quarterly review");
  expect(editor).toHaveTextContent(title);
  await userEvent.click(await findAction("button", "Send"));
  expect((await submitted.promise)?.parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      template: {
        type: "presentation",
        selection: expect.objectContaining({
          templateId: item.templateId,
          colorSystemId: "color-system:ocean-deep",
        }),
      },
    }),
  );
});

test("composer-template-recommendation-previews-002 direct and gallery previews restore focus on dismissal", async () => {
  servePresentationSlides(2);
  const { editor } = await openPresentationShelfWithDraft();
  const open = await previewControl(title);
  for (const close of ["Close", "Escape"]) {
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("1 / 2");
    if (close === "Close") {
      await userEvent.click(await findAction("button", "Close", dialog));
    } else {
      await userEvent.keyboard("{Escape}");
    }
    await waitFor(() => {
      return expect(open).toHaveFocus();
    });
    expect(editor).toHaveTextContent(/^Quarterly review$/);
  }
  await userEvent.click(await findAction("button", "View all"));
  const gallery = await screen.findByRole("dialog");
  const selected = await within(gallery).findByRole("combobox");
  expect(selected).toHaveTextContent("Presentation");
  const tile = await findAction(
    "button",
    "Preview " + title + " at current slide",
    gallery,
  );
  await userEvent.click(tile);
  await within(gallery).findByText("1 / 2");
  await userEvent.keyboard("{Escape}");
  const restored = await findAction(
    "button",
    "Preview " + title + " at current slide",
    gallery,
  );
  await waitFor(() => {
    return expect(restored).toHaveFocus();
  });
  expect(editor).toHaveTextContent(/^Quarterly review$/);
});

test("composer-template-recommendation-previews-003 the shelf preview is reachable and operable with both keyboard activation keys", async () => {
  servePresentationSlides(2);
  await openPresentationShelfWithDraft();
  const select = await findAction("button", title);
  const open = await previewControl(title);
  select.focus();
  await userEvent.keyboard("{Tab}");
  expect(open).toHaveFocus();
  for (const key of ["{Enter}", "[Space]"]) {
    await userEvent.keyboard(key);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("1 / 2");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      return expect(open).toHaveFocus();
    });
  }
});

test("composer-template-recommendation-previews-008 browsing the second custom page keeps the draft until Use and Send", async () => {
  const item = serveCustomPresentation();
  const { editor, submitted } = await openPresentationShelfWithDraft();
  const open = await previewControl(item.title);
  await userEvent.click(open);
  let dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByRole("textbox", { name: "Rename template" }),
  ).resolves.toHaveValue(item.title);
  await userEvent.click(
    await findAction("button", "Preview next slide", dialog),
  );
  await waitFor(() => {
    return expect(
      dialog.querySelector('img[src="' + item.pageUrls[1] + '"]'),
    ).toBeVisible();
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(open).toHaveFocus();
  });
  await userEvent.click(open);
  dialog = await screen.findByRole("dialog");
  await userEvent.click(
    await findAction("button", "Use this template", dialog),
  );
  await waitFor(() => {
    return expect(editor).toHaveTextContent(item.title);
  });
  expect(editor).toHaveTextContent("Quarterly review");
  expect(document.querySelector('[data-role="user"]')).toBeNull();
  await userEvent.click(await findAction("button", "Send"));
  expect((await submitted.promise)?.parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      template: { type: "custom", selection: { userTemplateId: item.id } },
    }),
  );
});

test("composer-template-recommendation-previews-007 a pending custom deletion holds its confirmation and failure keeps the recommendation", async () => {
  const item = serveCustomPresentation();
  const gate = context.mocks.deferred<void>();
  context.mocks.api(userTemplatesContract.delete, async ({ respond }) => {
    await gate.promise;
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Deck deletion failed" },
    });
  });
  const { editor, submitted } = await openPresentationShelfWithDraft();
  const open = await previewControl(item.title);
  await userEvent.click(open);
  const detail = await screen.findByRole("dialog");
  await userEvent.click(await findAction("button", "Delete", detail));
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete template?",
  });
  const remove = await findAction("button", "Delete template", confirmation),
    cancel = await findAction("button", "Cancel", confirmation);
  await userEvent.click(remove);
  try {
    await waitFor(() => {
      return expect(remove).toBeDisabled();
    });
    expect(cancel).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(await findAction("button", "Close", confirmation));
    expect(confirmation).toBeVisible();
    gate.resolve();
    await expect(
      within(confirmation).findByRole("alert"),
    ).resolves.toHaveTextContent(/couldn.t delete the template/i);
    expect(remove).toBeEnabled();
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    expect(confirmation).not.toBeInTheDocument();
    expect(detail).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      return expect(open).toHaveFocus();
    });
    expect(editor).toHaveTextContent(/^Quarterly review$/);
    expect(document.querySelector('[data-role="user"]')).toBeNull();
    expect(submitted.settled()).toBeFalsy();
  } finally {
    if (!gate.settled()) {
      gate.resolve();
    }
  }
});
