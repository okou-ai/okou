import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("The standalone app hides the install banner", async () => {
  context.mocks.browser.userAgent(IOS_SAFARI);
  context.mocks.browser.standaloneDisplayMode(true);

  await setupPage({ context, path: "/" });

  await expect(
    screen.findByRole("navigation", { name: "Main navigation" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("Install Okou for a better experience"),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Install app")).not.toBeInTheDocument();
});
