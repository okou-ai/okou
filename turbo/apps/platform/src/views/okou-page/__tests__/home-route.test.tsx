import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
test("home-route-003 Home consumes the prompt handoff into its own composer", async () => {
  await setupPage({ context, path: "/?prompt=Draft%20a%20launch%20plan" });
  const draft = await screen.findByText("Draft a launch plan", {
    selector: "[contenteditable=true] p",
  });
  expect(draft).toBeVisible();
  await waitFor(() => {
    expect(location.pathname + location.search + location.hash).toBe("/");
  });
});
