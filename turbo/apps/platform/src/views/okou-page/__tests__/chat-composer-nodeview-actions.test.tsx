import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { createTemplateGalleryHelpers } from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

/** Composer HTML copied from a client that still wrote block template chips. */
const LEGACY_CLIPBOARD =
  '<div data-composer-template-attachment="" templatetype="presentation" title="Legacy deck" category="slides"></div><p>Keep this draft.</p>';

async function findChipControl(label: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const control = queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-label") === label;
    });
    expect(control).toBeDefined();
    return control as HTMLElement;
  });
}

test("A template attachment keeps clipboard metadata without native hover hints", async () => {
  mockTemplateChat();
  await setupPage({ context, path: "/" });
  const editor = await findComposerEditor();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  // Copied composer HTML is plain HTML, so the paste is parsed as markup.
  const legacy = new DataTransfer();
  legacy.setData("text/html", LEGACY_CLIPBOARD);
  await user.paste(legacy);
  const preview = await findChipControl("Preview template Legacy deck");
  const chip = preview.closest<HTMLElement>(
    "[data-composer-template-attachment]",
  ) as HTMLElement;
  expect(editor).toHaveTextContent("Keep this draft.");
  expect(chip).not.toHaveAttribute("title");
  expect(chip.querySelector("[title]")).toBeNull();

  await user.click(editor);
  await user.keyboard("{Control>}a{/Control}");
  const copied = await user.copy();

  expect(copied?.getData("text/html")).toContain('title="Legacy deck"');

  click(preview);
  const dialog = await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });

  click(await findChipControl("Remove template Legacy deck"));

  await waitFor(() => {
    expect(
      editor.querySelector("[data-composer-template-attachment]"),
    ).toBeNull();
  });
  expect(editor).toHaveTextContent("Keep this draft.");
});
