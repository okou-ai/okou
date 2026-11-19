import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("A member opening an old invitation link keeps their redeem code", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: false,
  });

  await setupPage({
    context,
    path: "/onboarding/team?redeemCode=LAUNCH50",
  });

  expect(
    await screen.findByRole("heading", {
      name: "How would you like to start with Okou?",
    }),
  ).toBeInTheDocument();
  expect(window.location.pathname).toBe("/onboarding/experience");
  expect(new URLSearchParams(window.location.search).get("redeemCode")).toBe(
    "LAUNCH50",
  );
});
