import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { screen, waitFor, within } from "@testing-library/react";
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

test("The default agent Instructions bookmark opens the member’s saved personal Instructions", async () => {
  const personal = "Always include the source of research data.";
  const owner = "de000062-0000-4000-8000-000000000111";
  context.mocks.data.onboardingStatus({ defaultAgentId: owner });
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, {
      orgId: "org_default",
      userId: "test-user-123",
      content: personal,
      version: "1",
      updatedAt: "2026-11-01T12:00:00Z",
    });
  });
  await setupPage({ context, path: "/agents/" + owner + "?tab=instructions" });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  const editor = await within(settings).findByRole("textbox", {
    name: "Instructions",
  });
  expect(editor).toHaveTextContent(personal);
  expect(location.pathname).toBe("/");
  const query = new URL(location.href).searchParams;
  expect(query.get("settings")).toBe("my-okou");
  expect(query.get("focus")).toBe("instructions");
});
