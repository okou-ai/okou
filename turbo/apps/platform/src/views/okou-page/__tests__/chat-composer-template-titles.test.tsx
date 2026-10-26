import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { composerInlineTemplates } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";
import {
  openSavedPresentationPicker,
  savedPresentationDraft,
} from "./presentation-draft-test-helpers.ts";

const context = testContext();
const { mockPresentationHtml, mockTemplateChat } =
  createTemplateGalleryHelpers(context);

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
