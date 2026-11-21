import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
test("sidebar-account-menu-006 Help offers the public documentation in a separate tab and opens the keyboard reference", async () => {
  context.mocks.http.get("https://www.okou.ai/en/docs", () => {
    return new Response("<title>Docs</title>", {
      headers: { "Content-Type": "text/html" },
    });
  });
  await setupPage({
    context,
    path: "/",
    host: "app.okou.ai",
    auth: { user: { id: "alex", fullName: "Alex Rivera" } },
    sharedWorkerTestTransport: "message-port",
  });
  const rail = await screen.findByTestId("labeled-nav-rail");
  const account = await within(rail).findByLabelText("Alex Rivera");
  const help = async () => {
    click(account);
    const root = await screen.findByRole("menu");
    await userEvent.click(within(root).getByText("Help"));
    return screen.findByText("Docs");
  };
  const docs = (await help()).closest("a");
  expect(docs).toHaveAttribute("href", "https://www.okou.ai/en/docs");
  expect(docs).toHaveAttribute("target", "_blank");
  if (!docs) {
    throw new Error("Missing documentation link");
  }
  await userEvent.click(docs);
  await help();
  click(screen.getByText("Shortcuts"));
  const reference = await screen.findByRole("dialog", {
    name: "Keyboard Shortcuts",
  });
  expect(within(reference).getByText("Show shortcuts")).toBeInTheDocument();
});
