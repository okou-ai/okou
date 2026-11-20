import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("A nested sign-in route retains its state on the canonical Okou app", async () => {
  const returnUrl = "https://app.okou.ai/agents";
  const search = new URLSearchParams({
    __clerk_status: "verified",
    redirect_url: returnUrl,
  });
  const path = `/sign-in/factor-one?${search}#second-factor`;

  await setupPage({ context, path, host: "app.okou.ai", auth: null });

  await expect(screen.findByTestId("app-sign-in")).resolves.toBeVisible();
  const signIn = screen.getByTestId("clerk-sign-in");
  expect(signIn).toHaveAttribute("data-clerk-force-redirect-url", returnUrl);
  expect(window.location.href).toBe(`https://app.okou.ai${path}`);
  expect(new URL(window.location.href).searchParams.get("redirect_url")).toBe(
    returnUrl,
  );
});
