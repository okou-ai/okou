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
