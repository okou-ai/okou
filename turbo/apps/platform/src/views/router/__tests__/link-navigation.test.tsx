import { screen, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { externalProtocolHandler } from "../../../test/mocks/external-protocol-handler.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const unknown = "/missing-navigation-case";
function open(path: string) {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  return setupPage({
    context,
    host: "app.okou.ai",
    path,
    sharedWorkerTestTransport: "message-port",
  });
}
async function workflowsLink() {
  const rail = await screen.findByRole("navigation", { name: "Sidebar" });
  return within(rail).getByLabelText("Workflows");
}
test("link-navigation-001 Both exits from the missing page reach their labeled destinations", async () => {
  await open(unknown);
  click(await screen.findByText("Browse workflows"));
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/workflows");
  history.back();
  click(await screen.findByText("Back to home"));
  await expect(workflowsLink()).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/");
  expect(screen.queryByText("That page isn't here.")).not.toBeInTheDocument();
});
test("link-navigation-002 The error page sends the support action to Okou's mail recipient", async () => {
  const mail = externalProtocolHandler("mailto:");
  await open("/_/error");
  const alert = await screen.findByRole("alert");
  click(within(alert).getByText("support"));
  expect(mail).toStrictEqual(["mailto:contact@okou.ai"]);
});
test("link-navigation-004 Back traverses directly to the missing page after reselecting Workflows", async () => {
  await open(unknown);
  click(await screen.findByText("Browse workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  const link = await workflowsLink();
  expect(link).toHaveAttribute("aria-current", "page");
  click(link);
  expect(location.pathname).toBe("/workflows");
  history.back();
  await expect(
    screen.findByText("That page isn't here."),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe(unknown);
});
