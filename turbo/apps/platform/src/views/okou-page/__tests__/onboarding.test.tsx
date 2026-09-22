import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

test.each(["/", "/connectors/ssh"])(
  "A new user keeps prompt and connector context through onboarding from %s",
  async (entry) => {
    mockOnboardingNeeded();

    await setupPage({
      context,
      path: `${entry}?prompt=hello%20world&connector=github&vm0_source=presentation`,
    });

    await expect(
      screen.findByRole("heading", { name: "Try this prompt" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/onboarding");
    const onboardingContext = new URLSearchParams(search());
    expect(onboardingContext.get("prompt")).toBe("hello world");
    expect(onboardingContext.get("connector")).toBe("github");
    expect(onboardingContext.get("vm0_source")).toBe("presentation");
    expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
      "hello world",
    );
  },
);

test.each([
  {
    integration: "Slack",
    path: "/settings/slack?status=connected&workspace=Acme+Workspace",
    heading: "Connected to Slack!",
  },
  {
    integration: "Microsoft Teams",
    path: "/settings/teams?status=connected&teamName=Core+Team&botName=Okou",
    heading: "Connected to Microsoft Teams",
  },
])(
  "A $integration success return remains visible before onboarding",
  async ({ path, heading }) => {
    mockOnboardingNeeded();
    context.mocks.browser.open();

    await setupPage({ context, path });

    await expect(
      screen.findByRole("heading", { name: heading }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).not.toBe("/onboarding");
  },
);

test.each([
  "/settings/slack?error=access_denied",
  "/settings/teams?error=access_denied",
])(
  "An unsuccessful integration return at %s still requires onboarding",
  async (path) => {
    mockOnboardingNeeded();

    await setupPage({ context, path });

    await expect(
      screen.findByRole("heading", { name: "What do you want to make first" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/onboarding");
  },
);

test("An unknown nested onboarding path shows not found", async () => {
  await setupPage({
    context,
    path: "/onboarding/unknown?vm0_source=homepage",
  });

  await expect(
    screen.findByRole("heading", { name: "That page isn't here." }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/onboarding/unknown");
});
