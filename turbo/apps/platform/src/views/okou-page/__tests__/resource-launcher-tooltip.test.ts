import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { click } from "../../../__tests__/page-helper.ts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  resourceButton,
  setupResources,
} from "./chat-resources-test-helpers.ts";
const context = testContext();
test("chat-resources-004 Desktop pointer presents the closed trigger label before opening the artifacts dialog", async () => {
  await setupResources(context, {
    open: false,
    mock() {
      context.mocks.browser.matchMedia((query) => {
        return /(?:min-width|pointer: fine|hover: hover)/.test(query);
      });
    },
  });
  const trigger = resourceButton();
  const user = userEvent.setup({ delay: null });
  await waitFor(() => {
    expect(trigger).toBeEnabled();
  });
  await user.hover(trigger);
  fireEvent.pointerMove(trigger, {
    pointerType: "mouse",
    clientX: 28,
    clientY: 18,
  });
  const label = await waitFor(() => {
    const tip = document.querySelector('[data-slot="tooltip-content"]');
    expect(tip).toBeVisible();
    expect(tip).toHaveTextContent("Artifacts and chats");
    return tip;
  });
  click(trigger);
  await expect(
    screen.findByRole("dialog", { name: "Artifacts and chats" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    return expect(label).not.toBeVisible();
  });
});
