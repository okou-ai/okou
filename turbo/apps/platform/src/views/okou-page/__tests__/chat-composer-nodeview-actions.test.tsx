import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  context,
  findButton,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const PASSAGE = "The launch plan has three careful stages.";

async function openComposer(): Promise<HTMLElement> {
  installCapabilityChat({ events: completedConversation(PASSAGE) });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  return screen.getByRole("textbox", { name: "Message" });
}

test("A legacy template attachment can be previewed and removed without losing the draft", async () => {
  const editor = await openComposer();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  // Current pickers create inline chips. The supported HTML clipboard boundary
  // restores the block attachment still present in historical drafts.
  const clipboard = new DataTransfer();
  clipboard.setData(
    "text/html",
    '<div data-composer-template-attachment title="Legacy deck"></div><p>Keep this draft.</p>',
  );
  await user.paste(clipboard);
  const preview = await findButton("Preview template Legacy deck");

  await user.click(preview);
  await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");

  await user.click(await findButton("Remove template Legacy deck"));
  expect(preview).not.toBeInTheDocument();
  expect(editor).toHaveTextContent("Keep this draft.");
});
