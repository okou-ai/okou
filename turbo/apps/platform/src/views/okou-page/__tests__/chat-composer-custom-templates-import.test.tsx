import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  customTemplate,
  illustrationTemplate,
  mockCustomTemplates,
  openCustomPanel,
  tabByText,
} from "./chat-composer-custom-template-test-helpers.ts";
import {
  THREAD_ID,
  context,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";

/** What the Custom entry asks for, whatever the file turns out to be. */
const PROMPT = "Analyse this file and save it as a reusable template.";

/**
 * What the run is told on top of that request, and the member is not: which
 * guide reads the file — the Custom template dispatcher — and which catalog
 * the result belongs in.
 */
const GUIDANCE =
  "Analyse this file with the `extract-template` dispatcher in `okou-ai/okou-skills`: read `extract-template/SKILL.md` there, take the branch it routes this file to, and follow that branch. Publish with `okou user-template publish` and the `--kind` that branch produced, so it appears under Custom.";

function additionalInfo(message: UserMessageDocument): string[] {
  return message.parts.flatMap((part) => {
    return part.type === "additional_info" ? [part.text] : [];
  });
}

test("Uploading moves to Custom once the switch is on", async () => {
  mockCustomTemplates([customTemplate()]);

  const { dialog } = await openCustomPanel();

  // The built-in Presentation tab delegates importing to Custom.
  click(tabByText("Presentation"));
  await waitFor(() => {
    expect(
      dialog.querySelector("[data-presentation-template-import]"),
    ).toBeNull();
  });

  click(tabByText("Custom"));
  await within(dialog).findByText("Q3 board review");
  expect(within(dialog).getByLabelText("Import template")).toBeInTheDocument();
});

test("A document can be imported while browsing images", async () => {
  mockCustomTemplates([illustrationTemplate()]);
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000011",
    filename: "brand-report.docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 5,
    url: "https://cdn.example.test/brand-report.docx",
  });

  const { user, dialog, capture } = await openCustomPanel();

  click(tabByText("Custom"));
  await user.upload(
    await within(dialog).findByLabelText("Import template"),
    new File(["docx"], "brand-report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );

  await waitFor(() => {
    expect(capture.runPrompts).toHaveLength(1);
  });
  // The `extract-template` guide decides whether the file is a deck or a
  // document; repeating that here would give the run two answers that can
  // disagree. What the member reads is the request they made, one sentence
  // long whatever the file turns out to be.
  expect(capture.runPrompts[0]).toBe(PROMPT);
  // The catalog still has to be said, because the guide's presentation branch
  // names the other one — so it is said where only the run reads it, along
  // with the `--kind` a document needs to avoid the flag's presentation
  // default, and the repository that tells the dispatcher apart from the
  // registry's presentation-only copy.
  expect(additionalInfo(capture.sentMessages[0]!)).toStrictEqual([GUIDANCE]);
});

test("Choosing a source leaves the picker for the thread it starts", async () => {
  mockCustomTemplates([customTemplate()]);
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000013",
    filename: "brand-report.docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 5,
    url: "https://cdn.example.test/brand-report.docx",
  });
  const user = userEvent.setup({ delay: null });
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: true },
  });
  const dialog = await openTemplatePicker(user);

  click(tabByText("Custom"));
  await user.upload(
    await within(dialog).findByLabelText("Import template"),
    new File(["docx"], "brand-report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );

  await waitFor(() => {
    expect(capture.runPrompts).toHaveLength(1);
  });
  // The import sends a message, and the thread it sends into is the one the
  // member was just handed. A picker left open covers the run they were sent
  // to watch — and from an existing chat nothing else takes it away.
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
