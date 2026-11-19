import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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

function queryTitleHint(title: string) {
  return screen.queryByText(title, {
    selector: '[data-slot="tooltip-content"]',
  });
}

test("Leaving a built-in caption dismisses its title hint", async () => {
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
  await user.hover(caption);
  await waitFor(() => {
    expect(queryTitleHint(template.title)).toBeVisible();
  });

  await user.unhover(caption);

  await waitFor(() => {
    expect(queryTitleHint(template.title)).not.toBeInTheDocument();
  });
});
