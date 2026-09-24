import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  holdElementAnimations,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import {
  AGENT_ID,
  context,
  expectInlineTemplate,
  mockTemplateChat,
  openTemplatePicker,
  sendComposerMessage,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";

function buttonNamed(name: string, container: ParentNode = document.body) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`${name} button not found`);
  }
  return button;
}

test("Preview a website template and return to its picker", async () => {
  const template = WEBSITE_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Website template fixture not found");
  }
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });
  const picker = await openTemplatePicker(user, "Website");
  await user.click(
    within(picker).getByLabelText(`Preview website template ${template.title}`),
  );
  const frame = await screen.findByTitle(
    `${template.title} website full preview`,
  );
  expect(frame).toHaveAttribute("src", template.previewUrl);
  const previewDialog = frame.closest<HTMLElement>('[role="dialog"]');
  if (!previewDialog) {
    throw new Error("Website preview dialog not found");
  }
  // The preview opens as a dialog inside the gallery, which is what lets the
  // gallery step out of view for as long as it is up. Moving it out of the
  // gallery's tree would leave the two panels overlapping again.
  expect(picker).toHaveAttribute("data-nested-dialog-open");
  const finishCloseTransition = holdElementAnimations(previewDialog);
  await user.click(buttonNamed("Website", previewDialog));
  expect(previewDialog).toBeVisible();
  finishCloseTransition();
  const returnedPicker = await waitFor(() => {
    const currentPicker = screen.getByRole("dialog");
    expect(
      within(currentPicker).getByLabelText(
        `Preview website template ${template.title}`,
      ),
    ).toBeVisible();
    return currentPicker;
  });
  expect(returnedPicker).not.toHaveAttribute("data-nested-dialog-open");
});

test("Select and send a website template", async () => {
  const capture = mockTemplateChat();
  const template = WEBSITE_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Website template fixture not found");
  }
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });
  const picker = await openTemplatePicker(user, "Website");
  await user.click(
    within(picker).getByLabelText(`Select website template ${template.title}`),
  );
  await expectInlineTemplate(template.title);
  await sendComposerMessage(user, "Build this launch site");
  await waitFor(() => {
    return expect(capture.sentMessages).toHaveLength(1);
  });
  expect(templatePart(capture.sentMessages[0]!).template).toStrictEqual({
    type: "website",
    selection: { websiteTemplateId: template.id },
  });
});
