import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const IOS_SAFARI_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

function mockIOSSafari(standalone: boolean): void {
  context.mocks.browser.userAgent(IOS_SAFARI_USER_AGENT);
  context.mocks.browser.standaloneDisplayMode(standalone);
}

test("The standalone app hides the install banner", async () => {
  mockIOSSafari(true);

  await setupPage({ context, path: "/", host: "app.okou.ai" });

  await expect(
    screen.findByRole("navigation", { name: "Main navigation" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Install Okou for a better experience")).toBeNull();
});
