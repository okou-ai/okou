import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import {
  buttonContainingText,
  composerInlineTemplates,
} from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  createUploadedTemplate,
  expectInlineTemplate,
  openTemplatePicker,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";
import {
  openSavedPresentationPicker,
  savedPresentationDraft,
} from "./presentation-draft-test-helpers.ts";

const context = testContext();
const {
  mockPresentationHtml,
  mockPresentationTemplateLibrary,
  mockTemplateChat,
} = createTemplateGalleryHelpers(context);

const UPLOADED_TEMPLATE_NOW_MS = 1_785_542_400_000;

async function expectTitleHint(title: string): Promise<void> {
  // This repeats a name the preview control already exposes. The visual hint
  // intentionally stays outside its accessible description.
  await waitFor(() => {
    expect(
      screen.getByText(title, { selector: '[data-slot="tooltip-content"]' }),
    ).toBeVisible();
  });
}

async function openBuiltInTitleHint() {
  mockTemplateChat();
  const [template, selected] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!template || !selected) {
    throw new Error("Expected presentation templates to preview and retain");
  }
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, savedPresentationDraft(selected));
  });
  mockPresentationHtml(template.embedUrl, ["Opening"]);
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CustomTemplates]: false },
  });
  const picker = await openSavedPresentationPicker(selected.title);
  const caption = within(picker).getByText(template.title);
  return { template, selected, user, picker, caption };
}

test("Hovering a built-in caption shows its hint without changing the selection", async () => {
  const { template, selected, user, picker, caption } =
    await openBuiltInTitleHint();
  await user.hover(caption);
  await expectTitleHint(template.title);
  expect(picker).toBeInTheDocument();
  const inline = composerInlineTemplates();
  expect(inline).toHaveLength(1);
  expect(inline[0]).toHaveTextContent(selected.title);
  expect(
    within(picker).queryByLabelText(`${template.title} slide preview`),
  ).not.toBeInTheDocument();
});

test("Leaving a built-in caption dismisses its title hint", async () => {
  const { template, user, caption } = await openBuiltInTitleHint();
  await user.hover(caption);
  await expectTitleHint(template.title);
  await user.unhover(caption);
  await waitFor(() => {
    expect(
      screen.queryByText(template.title, {
        selector: '[data-slot="tooltip-content"]',
      }),
    ).not.toBeInTheDocument();
  });
});

test("A shared imported template cannot be renamed and can still be applied", async () => {
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

  await user.click(preview);
  await screen.findByRole("group", {
    name: `${template.title} slide preview`,
  });
  // The name is read-only: the breadcrumb states it, and nothing edits it.
  expect(
    within(picker).getByRole("heading", {
      name: `Template / ${template.title}`,
      level: 2,
    }),
  ).toBeInTheDocument();
  expect(
    within(picker).queryByRole("textbox", { name: "Rename template" }),
  ).not.toBeInTheDocument();
  expect(
    within(picker).queryByText("Change template visibility"),
  ).not.toBeInTheDocument();
  expect(within(picker).queryByText("Delete")).not.toBeInTheDocument();
  expect(composerInlineTemplates()).toHaveLength(0);

  await user.click(buttonContainingText("Template", picker));
  await user.click(
    await within(picker).findByLabelText(`Select template ${template.title}`),
  );
  await expectInlineTemplate(template.title);
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(picker).not.toBeInTheDocument();
});
