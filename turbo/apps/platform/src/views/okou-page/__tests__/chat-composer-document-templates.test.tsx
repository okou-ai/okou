import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { HttpResponse } from "msw";
import zhHansCommon from "../../../i18n/locales/zh-Hans/common.json";
import zhHansCommonUrl from "../../../i18n/locales/zh-Hans/common.json?url";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";
import {
  composerInlineTemplates,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";

function control(
  dialog: HTMLElement,
  role: "tab" | "button",
  name: string,
): HTMLElement {
  const result = queryAllByRoleFast(role, dialog).find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
  if (!result) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return result;
}

async function setup(enabled = true) {
  const capture = mockTemplateChat();
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: false,
      [FeatureSwitchKey.BuiltinDocumentTemplates]: enabled,
    },
  });
  return { user, capture };
}

test("Document remains hidden when its rollout switch is off", async () => {
  const { user } = await setup(false);
  const dialog = await openTemplatePicker(user);
  expect(
    queryAllByRoleFast("tab", dialog).map((tab) => {
      return tab.textContent;
    }),
  ).not.toContain("Document");
});

test("Document search and scroll survive preview; Use preserves the draft and does not send", async () => {
  const { user, capture } = await setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("Prepare the invoice for my client.");
  const dialog = await openTemplatePicker(user);
  const tabs = queryAllByRoleFast("tab", dialog);
  expect(
    tabs.map((tab) => {
      return tab.textContent;
    }),
  ).toStrictEqual([
    "Presentation",
    "Document",
    "Website",
    "Illustration",
    "Workflow",
  ]);
  click(control(dialog, "tab", "Document"));
  await user.click(control(dialog, "button", "Invoice"));
  await user.type(
    within(dialog).getByRole("textbox", { name: "Search documents" }),
    "simple",
  );
  const grid = dialog.querySelector<HTMLElement>(
    "[data-document-template-grid-scroll]",
  );
  if (!grid) {
    throw new Error("Document grid not found");
  }
  grid.scrollTop = 120;
  fireEvent.scroll(grid);
  click(control(dialog, "button", "Preview Simple invoice"));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    within(dialog).getByRole("heading", { name: "Simple invoice" }),
  ).toBeVisible();
  await user.keyboard("{Escape}");
  expect(
    within(dialog).getByRole("textbox", { name: "Search documents" }),
  ).toHaveValue("simple");
  const restored = dialog.querySelector<HTMLElement>(
    "[data-document-template-grid-scroll]",
  );
  expect(restored?.scrollTop).toBe(120);
  expect(control(dialog, "button", "Preview Simple invoice")).toHaveFocus();
  click(control(dialog, "button", "Use Simple invoice"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  const preservedEditor = await findComposerEditor();
  expect(preservedEditor).toHaveTextContent(
    "Prepare the invoice for my client.",
  );
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent("Simple invoice");
  expect(capture.sentMessages).toHaveLength(0);
  await user.click(await findComposerEditor());
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "template",
    titleSnapshot: "Simple invoice",
    template: {
      type: "document",
      selection: { documentTemplateId: "document-template:simple-invoice" },
    },
  });
});

test("Document empty results can be reset and failed preview pages can be retried", async () => {
  const { user } = await setup();
  const dialog = await openTemplatePicker(user);
  click(control(dialog, "tab", "Document"));
  await user.type(
    within(dialog).getByRole("textbox", { name: "Search documents" }),
    "no-such-document",
  );
  expect(within(dialog).getByText("No matching templates")).toBeVisible();
  click(control(dialog, "button", "Clear filters"));
  click(control(dialog, "button", "Preview Simple invoice"));
  fireEvent.error(within(dialog).getByAltText("Page 1"));
  expect(within(dialog).getByText("Preview unavailable")).toBeVisible();
  click(control(dialog, "button", "Retry"));
  expect(within(dialog).getByAltText("Page 1")).toBeInTheDocument();
});

test("Document search matches the localized purpose category", async () => {
  mockTemplateChat();
  // The shared locale fixture serves placeholders; this test needs the real labels.
  context.mocks.http.get(zhHansCommonUrl, () => {
    return HttpResponse.json(zhHansCommon);
  });
  context.mocks.browser.languages(["zh-CN"]);
  context.mocks.browser.cookie("");
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?templatePicker=document`,
    locale: "zh-Hans",
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: false,
      [FeatureSwitchKey.BuiltinDocumentTemplates]: true,
    },
  });
  const dialog = await screen.findByRole("dialog");
  await user.type(
    await within(dialog).findByRole("textbox", { name: "搜索文档模板" }),
    "发票",
  );
  expect(within(dialog).getAllByLabelText(/^预览 /u)).toHaveLength(7);
  expect(within(dialog).getByText("Simple invoice")).toBeVisible();
});
