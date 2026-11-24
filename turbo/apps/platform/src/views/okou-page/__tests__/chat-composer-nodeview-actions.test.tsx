import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  findButton,
  readyChat,
  RUN_PATH,
  createChatCapabilityHelpers,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const PASSAGE = "The launch plan has three careful stages.";

async function openComposer(): Promise<HTMLElement> {
  installCapabilityChat({ events: completedConversation(PASSAGE) });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  return screen.getByRole("textbox", { name: "Message" });
}

test("A restored template attachment keeps clipboard metadata and can be removed", async () => {
  const editor = await openComposer();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  // Current recommendations create inline chips. The supported HTML clipboard boundary
  // restores the block attachment still present in historical drafts.
  const clipboard = new DataTransfer();
  clipboard.setData(
    "text/html",
    '<div data-composer-template-attachment title="Legacy deck"></div><p>Keep this draft.</p>',
  );
  await user.paste(clipboard);
  const attachment = editor.querySelector(
    "[data-composer-template-attachment]",
  );
  expect(attachment).toHaveTextContent("Legacy deck");

  await user.keyboard("{Control>}a{/Control}");
  const copied = await user.copy();
  const copiedDocument = new DOMParser().parseFromString(
    copied?.getData("text/html") ?? "",
    "text/html",
  );
  expect(
    copiedDocument.querySelector("[data-composer-template-attachment]"),
  ).toHaveAttribute("title", "Legacy deck");

  await user.click(await findButton("Remove template Legacy deck"));
  expect(attachment).not.toBeInTheDocument();
  expect(editor).toHaveTextContent("Keep this draft.");
});
