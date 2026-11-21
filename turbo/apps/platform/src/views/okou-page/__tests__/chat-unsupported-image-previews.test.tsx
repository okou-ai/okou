import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
const ORIGINAL =
  "https://cdn.vm7.io/artifacts/tests/chat-attachments/photo.BMP";

test("assistant BMP images display the original in the thread and lightbox", async () => {
  installCapabilityChat({
    events: completedConversation(
      `Here is the scan you asked for.\n\n![photo.BMP](${ORIGINAL})`,
    ),
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  const inline = await waitFor(() => {
    const image = document.querySelector<HTMLImageElement>(
      `[data-role='assistant'] img[alt="photo.BMP"]`,
    );
    expect(image).toHaveAttribute("src", ORIGINAL);
    return image as HTMLImageElement;
  });

  click(inline.closest("a, button") ?? inline);

  const lightbox = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(
      within(lightbox).getByRole("img", { name: "photo.BMP" }),
    ).toHaveAttribute("src", ORIGINAL);
  });
});
