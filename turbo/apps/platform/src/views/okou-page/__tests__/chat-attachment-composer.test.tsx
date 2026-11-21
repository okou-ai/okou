import { test, expect } from "vitest";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  boxAnnotation,
  draftAttachment,
  draftForAttachment,
} from "./chat-attachment-test-helpers.ts";
import { conversation } from "./attachment-preview-boundaries.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
const context = testContext();
test("chat-attachment-composer-001 pasted notes and dropped PDF are independently removable", async () => {
  const text = new File(["Field notes"], "field-notes.txt", {
      type: "text/plain",
    }),
    pdf = new File(["%PDF-1.5"], "briefing.pdf", { type: "application/pdf" });
  await conversation(context, {});
  const editor = await findComposerEditor();
  editor.focus();
  context.mocks.upload.success({
    id: crypto.randomUUID(),
    filename: text.name,
    contentType: text.type,
    size: text.size,
    url: "https://cdn.okou.io/artifacts/field/files/note.txt",
  });
  const transfer = new DataTransfer();
  transfer.setData("text/plain", "Review my field notes");
  transfer.items.add(text);
  fireEvent.paste(editor, { clipboardData: transfer });
  await waitFor(() => {
    return expect(editor).toHaveTextContent("Review my field notes");
  });
  await expect(
    findAction("button", "Remove " + text.name),
  ).resolves.toBeVisible();
  context.mocks.upload.success({
    id: crypto.randomUUID(),
    filename: pdf.name,
    contentType: pdf.type,
    size: pdf.size,
    url: "https://cdn.okou.io/artifacts/field/files/briefing.pdf",
  });
  const drop = new DataTransfer();
  drop.items.add(pdf);
  fireEvent.dragOver(editor, { dataTransfer: drop });
  fireEvent.drop(editor, { dataTransfer: drop });
  await expect(
    findAction("button", "Remove " + pdf.name),
  ).resolves.toBeVisible();
  await expect(
    findAction("button", "Remove " + text.name),
  ).resolves.toBeVisible();
});
function markedDraft(filename: string, note: string) {
  const image = draftAttachment(filename, {
    id: crypto.randomUUID(),
    annotatedFileId: crypto.randomUUID(),
    annotations: boxAnnotation([{ id: crypto.randomUUID(), ordinal: 1, note }]),
  });
  return { image, draft: draftForAttachment(image) };
}
test("chat-attachment-composer-003 the dispatched billing instruction carries the saved structured annotation", async () => {
  const { image, draft } = markedDraft(
    "billing-page.png",
    "Tighten this spacing.",
  );
  const sent: unknown[] = [];
  await conversation(context, {
    draft,
    onSendRequest: (body) => {
      sent.push(body);
    },
  });
  await screen.findByTestId("composer-attachment-mark-count");
  await fill(await findComposerEditor(), "Fix the billing page");
  click(await findAction("button", "Send"));
  await waitFor(() => {
    return expect(sent).toContainEqual(
      expect.objectContaining({
        prompt: "Fix the billing page",
        userMessage: expect.objectContaining({
          parts: expect.arrayContaining([
            {
              type: "file",
              fileId: image.id,
              filenameSnapshot: image.filename,
              contentType: "image/png",
              annotatedFileId: image.annotatedFileId,
              annotations: image.annotations,
            },
          ]),
        }),
      }),
    );
  });
});
test("chat-attachment-composer-006 the restored mark opens on its saved image", async () => {
  const { image, draft } = markedDraft("saved-layout.png", "Align the margin.");
  await conversation(context, { draft });
  await expect(
    screen.findByTestId("composer-attachment-mark-count"),
  ).resolves.toHaveTextContent("1");
  click(await findAction("button", "Open image preview for " + image.filename));
  const dialog = await screen.findByTestId("attachment-lightbox");
  const layer = await within(dialog).findByTestId("annotation-mark-layer");
  expect(within(layer).getByText("1")).toBeVisible();
  expect(layer).toHaveTextContent("1");
});
