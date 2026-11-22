import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();

test("Greet with Okou's own animated avatar under My Okou", async () => {
  context.mocks.browser.matchMedia(false);
  await setupPage({
    context,
    path: `/?compose=1`,
  });
  const greeting = await screen.findByTestId("chat-greeting");

  const avatar = greeting.querySelector("[data-okou-avatar]");
  expect(avatar).toHaveAttribute("data-okou-avatar", "animated");
});
