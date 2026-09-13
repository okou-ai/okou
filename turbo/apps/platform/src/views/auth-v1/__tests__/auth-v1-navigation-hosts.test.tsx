import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test.each(["sign-in", "sign-up"] as const)(
  "A nested %s route retains its state on the canonical Okou app",
  async (mode) => {
    const returnUrl = "https://app.okou.ai/agents?source=auth-task";
    const pathname = `/${mode}/tasks/choose-organization`;
    const search = `?session_id=session-test&redirect_url=${encodeURIComponent(returnUrl)}`;
    const hash = "#/tasks/choose-organization?attempt=1";
    await setupPage({
      context,
      host: "app.okou.ai",
      path: pathname + search + hash,
      auth: null,
    });
    expect(screen.getByTestId(`clerk-${mode}`)).toBeVisible();
    expect(location.origin).toBe("https://app.okou.ai");
    expect(location.pathname).toBe(pathname);
    expect(location.search).toBe(search);
    expect(location.hash).toBe(hash);
    expect(screen.getByTestId(`clerk-${mode}`)).toHaveAttribute(
      "data-clerk-force-redirect-url",
      returnUrl,
    );
  },
);
