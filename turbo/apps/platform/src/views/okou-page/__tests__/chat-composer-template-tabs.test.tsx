import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import { tabByText } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
  expectInlineTemplate,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

test("chat-composer-template-tabs-001 picks a built-in deck while the custom catalog is pending", async () => {
  mockTemplateChat();
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(userTemplatesContract.list, async ({ respond }) => {
    started.resolve();
    await release.promise;
    return respond(200, []);
  });
  try {
    await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await clickComposerAddMenuItem("Template");
    const picker = within(await screen.findByRole("dialog"));
    await started.promise;
    click(tabByText("Website"));
    expect(
      picker.getByLabelText("Select website template Blueprint Grid"),
    ).toBeEnabled();
    click(tabByText("Presentation"));
    const deck = await picker.findByLabelText("Select template Paper magazine");
    expect(deck).toBeEnabled();
    click(deck);
    await expectInlineTemplate("Paper magazine");
  } finally {
    release.resolve();
  }
});

test("chat-composer-template-tabs-002 moves focus and the active panel together in both directions", async () => {
  mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?templatePicker=slides`,
  });
  const picker = within(await screen.findByRole("dialog"));
  const presentation = tabByText("Presentation");
  await waitFor(() => {
    expect(presentation).toHaveFocus();
  });
  for (const [key, category] of [
    ["{ArrowDown}", "Document"],
    ["{ArrowUp}", "Presentation"],
  ] as const) {
    await userEvent.keyboard(key);
    const panel = await picker.findByRole("tabpanel", { name: category });
    const tab = tabByText(category);
    expect(tab).toHaveFocus();
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAttribute("aria-controls", panel.id);
    expect(picker.getAllByRole("tabpanel")).toHaveLength(1);
  }
});
