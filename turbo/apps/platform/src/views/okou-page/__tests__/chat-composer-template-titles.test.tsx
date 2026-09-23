import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import {
  buttonContainingText,
  composerInlineTemplates,
  tabByText,
} from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  context,
  createUploadedTemplate,
  expectInlineTemplate,
  mockPresentationHtml,
  mockPresentationTemplateLibrary,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";

const UPLOADED_TEMPLATE_NOW_MS = 1_785_542_400_000;

async function tabTo(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
): Promise<void> {
  for (
    let index = 0;
    index < 12 && document.activeElement !== control;
    index++
  ) {
    await user.keyboard("{Tab}");
  }
  expect(control).toHaveFocus();
}

async function expectTitleHint(title: string): Promise<void> {
  // This repeats a name the preview control already exposes. The visual hint
  // intentionally stays outside its accessible description.
  await waitFor(() => {
    expect(
      screen.getByText(title, { selector: '[data-slot="tooltip-content"]' }),
    ).toBeVisible();
  });
}

test("A built-in title hint follows caption hover without opening a preview", async () => {
  mockTemplateChat();
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a built-in presentation template");
  }
  mockPresentationHtml(template.embedUrl, ["Opening"]);
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: false },
  });
  const picker = await openTemplatePicker(user, "Presentation");
  const caption = within(picker).getByText(template.title);

  await user.hover(caption);
  await expectTitleHint(template.title);
  expect(composerInlineTemplates()).toHaveLength(0);
  expect(
    screen.queryByRole("group", { name: `${template.title} slide preview` }),
  ).not.toBeInTheDocument();
  await user.unhover(caption);
  await waitFor(() => {
    expect(
      screen.queryByText(template.title, {
        selector: '[data-slot="tooltip-content"]',
      }),
    ).not.toBeInTheDocument();
  });
});

test("Built-in title hints follow keyboard navigation between preview controls", async () => {
  mockTemplateChat();
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  const nextTemplate = PRESENTATION_TEMPLATE_PICKER_ITEMS[1];
  if (!template || !nextTemplate) {
    throw new Error("Expected two built-in presentation templates");
  }
  mockPresentationHtml(template.embedUrl, ["Opening"]);
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: false },
  });
  const picker = await openTemplatePicker(user, "Presentation");
  const previewLabel = `Preview ${template.title} at current slide`;
  const preview = within(picker).getByLabelText(previewLabel);
  const useTemplate = within(picker).getByLabelText(
    `Select template ${template.title}`,
  );

  await tabTo(user, preview);
  await expectTitleHint(template.title);
  expect(preview).toHaveAccessibleName(previewLabel);
  expect(preview).toHaveAccessibleDescription("");
  expect(useTemplate).toHaveAttribute("aria-pressed", "false");
  expect(composerInlineTemplates()).toHaveLength(0);
  await user.keyboard("{Tab}");
  expect(useTemplate).toHaveFocus();
  await user.keyboard("{Tab}");
  expect(
    within(picker).getByLabelText(
      `Preview ${nextTemplate.title} at current slide`,
    ),
  ).toHaveFocus();
  await expectTitleHint(nextTemplate.title);
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(useTemplate).toHaveFocus();
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(preview).toHaveFocus();
  await expectTitleHint(template.title);
});

test("A built-in title hint preserves keyboard preview and independent selection", async () => {
  mockTemplateChat();
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a built-in presentation template");
  }
  mockPresentationHtml(template.embedUrl, ["Opening"]);
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: false },
  });
  const picker = await openTemplatePicker(user, "Presentation");
  const previewLabel = `Preview ${template.title} at current slide`;
  const preview = within(picker).getByLabelText(previewLabel);

  await user.click(tabByText("Presentation"));
  await tabTo(user, preview);
  await expectTitleHint(template.title);

  await user.keyboard("{Enter}");
  const detail = await screen.findByRole("group", {
    name: `${template.title} slide preview`,
  });
  expect(detail).toHaveFocus();
  expect(
    within(picker).getByRole("heading", { name: template.title, level: 3 }),
  ).toBeInTheDocument();
  expect(composerInlineTemplates()).toHaveLength(0);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(within(picker).getByLabelText(previewLabel)).toHaveFocus();
  });
  await user.keyboard("{Tab}");
  expect(
    within(picker).getByLabelText(`Select template ${template.title}`),
  ).toHaveFocus();
  await user.keyboard(" ");
  await expectInlineTemplate(template.title);
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(picker).not.toBeInTheDocument();
});

test("A shared imported template keeps its full name available without applying it", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  mockTemplateChat();
  const template = createUploadedTemplate({
    id: "83000000-0000-4000-a000-000000000001",
    title:
      "季度战略复盘与下一阶段执行计划AnnualPlanningReviewWithoutSpacesAndWithEveryDepartmentIncluded",
    canManage: false,
  });
  mockPresentationTemplateLibrary([template]);
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: false },
  });
  const picker = await openTemplatePicker(user, "Presentation");
  const previewLabel = `Preview ${template.title} at current slide`;
  const preview = await within(picker).findByLabelText(previewLabel);
  const caption = within(picker).getByText(template.title);

  await user.hover(caption);
  await expectTitleHint(template.title);
  await user.unhover(caption);
  await user.click(tabByText("Presentation"));
  await tabTo(user, preview);
  await expectTitleHint(template.title);
  expect(preview).toHaveAccessibleName(previewLabel);
  expect(preview).toHaveAccessibleDescription("");
  expect(composerInlineTemplates()).toHaveLength(0);

  await user.keyboard(" ");
  const detail = await screen.findByRole("group", {
    name: `${template.title} slide preview`,
  });
  expect(detail).toHaveFocus();
  expect(
    within(picker).getByRole("heading", { name: template.title, level: 3 }),
  ).toBeInTheDocument();
  expect(
    within(picker).queryByRole("textbox", { name: "Rename template" }),
  ).not.toBeInTheDocument();
  expect(composerInlineTemplates()).toHaveLength(0);

  await user.click(buttonContainingText("Template", picker));
  await waitFor(() => {
    expect(within(picker).getByLabelText(previewLabel)).toHaveFocus();
  });
  await user.keyboard("{Tab}");
  expect(
    within(picker).getByLabelText(`Select template ${template.title}`),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  await expectInlineTemplate(template.title);
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(picker).not.toBeInTheDocument();
});

test("Touch preview exposes an owned imported title without changing its name", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  mockTemplateChat();
  const template = createUploadedTemplate({
    id: "83000000-0000-4000-a000-000000000002",
    title: "区域经营计划与跨部门协作复盘LongUnbrokenPresentationTemplateTitle",
    canManage: true,
  });
  mockPresentationTemplateLibrary([template]);
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: false },
  });
  const picker = await openTemplatePicker(user, "Presentation");
  const previewLabel = `Preview ${template.title} at current slide`;
  const preview = await within(picker).findByLabelText(previewLabel);

  await user.pointer({ keys: "[TouchA]", target: preview });
  await screen.findByRole("group", {
    name: `${template.title} slide preview`,
  });
  const titleField = within(picker).getByRole("textbox", {
    name: "Rename template",
  });
  expect(titleField).toHaveValue(template.title);
  expect(composerInlineTemplates()).toHaveLength(0);
  await user.click(titleField);
  await user.keyboard("{Tab}");
  await user.click(buttonContainingText("Template", picker));
  await waitFor(() => {
    expect(within(picker).getByLabelText(previewLabel)).toHaveFocus();
  });
  expect(
    within(picker).getByText(template.title, { selector: "p" }),
  ).toBeInTheDocument();
  expect(composerInlineTemplates()).toHaveLength(0);
});
