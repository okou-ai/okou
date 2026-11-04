import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test.each([true, false])(
  "The retired invite URL continues to experience for isAdmin=%s",
  async (isAdmin) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin,
    });
    await setupPage({
      context,
      locale: "en-US",
      path: `${ROUTES.onboardingTeam}?redeemCode=LAUNCH50`,
    });
    await screen.findByRole("heading", {
      name: "How would you like to start with Okou?",
    });
    expect(pathname()).toBe(ROUTES.onboardingExperience);
    expect(new URLSearchParams(search()).get("redeemCode")).toBe("LAUNCH50");
  },
);
