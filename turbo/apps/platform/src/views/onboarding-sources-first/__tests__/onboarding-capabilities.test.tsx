import { expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
const context = testContext();
const capabilities = "/onboarding/capabilities";
const heading = "More ways to get your work done";
function onboarding(isAdmin: boolean) {
  context.mocks.data.onboardingStatus({
    isAdmin,
    needsOnboarding: true,
    onboardingComplete: false,
  });
}
test("onboarding-capabilities-005 disabled tools and the edited presentation request survive backward and forward navigation", async () => {
  onboarding(true);
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, {
      disabledTools: [
        "web-search",
        "image-generation",
        "people-search",
        "finance",
        "data-search",
      ],
    });
  });
  await setupPage({ context, path: capabilities });
  const tools = await screen.findByRole("list", {
    name: "Built-in capabilities",
  });
  for (const control of within(tools).getAllByRole("switch")) {
    expect(control).not.toBeChecked();
  }
  click(await findAction("button", "Back"));
  click(await findAction("button", "Not now"));
  await screen.findByRole("switch", { name: "Financial data" });
  for (const control of screen.getAllByRole("switch")) {
    expect(control).not.toBeChecked();
  }
  click(await findAction("button", "Continue"));
  const task = "Show the most urgent fulfillment delays.";
  await fill(await screen.findByLabelText("Your first task"), task);
  click(await findAction("button", "Presentation"));
  click(await findAction("button", "Back"));
  await screen.findByRole("switch", { name: "Financial data" });
  for (const control of screen.getAllByRole("switch")) {
    expect(control).not.toBeChecked();
  }
  click(await findAction("button", "Continue"));
  await expect(screen.findByLabelText("Your first task")).resolves.toHaveValue(
    task,
  );
  await expect(findAction("button", "Presentation")).resolves.toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
test("onboarding-capabilities-007 a catalog failure leaves the first task accessible", async () => {
  onboarding(true);
  context.mocks.http.post(/\/mcp$/u, () => {
    return new HttpResponse(null, { status: 500 });
  });
  await setupPage({ context, path: capabilities });
  await expect(
    screen.findByText("Your tool settings could not be loaded."),
  ).resolves.toBeInTheDocument();
  click(await findAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Let’s start your first task" });
});
test.each([
  ["onboarding-capabilities-008", "administrator", true],
  ["onboarding-capabilities-009", "member", false],
] as const)(
  "%s keeps capabilities between chat channels and the first task for a new %s",
  async (_id, role, isAdmin) => {
    onboarding(isAdmin);
    await setupPage({
      context,
      path: "/onboarding/slack",
      auth: { user: { id: "new-" + role, fullName: "Incoming " + role } },
    });
    click(await findAction("button", "Not now"));
    await screen.findByRole("heading", { name: heading });
    click(await findAction("button", "Back"));
    await expect(findAction("button", "Not now")).resolves.toBeEnabled();
    expect(window.location.pathname).toBe("/onboarding/slack");
    click(await findAction("button", "Not now"));
    await screen.findByRole("heading", { name: heading });
    expect(window.location.pathname).toBe(capabilities);
    click(await findAction("button", "Continue"));
    await screen.findByRole("heading", { name: "Let’s start your first task" });
  },
);
test("onboarding-capabilities-010 the Tools dialog discovers a new family while onboarding keeps its own catalog", async () => {
  onboarding(true);
  let family = "social";
  context.mocks.http.post(/\/mcp$/u, async ({ request }) => {
    const message = (await request.json()) as { id: string };
    return HttpResponse.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "sample_search",
            inputSchema: { type: "object", properties: {} },
            _meta: { "ai.okou/data": { family } },
          },
        ],
        _meta: {
          "ai.okou/data": {
            families: [
              {
                id: family,
                title: { "en-US": "Router " + family },
                description: { "en-US": "Research " + family },
                summary: "Research " + family,
              },
            ],
          },
        },
      },
    });
  });
  await setupPage({ context, path: capabilities });
  await screen.findByRole("switch", { name: "Router social" });
  family = "future-family";
  click(await findAction("button", "Test User"));
  click(await screen.findByText("Settings"));
  const dialog = await screen.findByRole("dialog");
  click(await findAction("button", "Tools", dialog));
  await within(dialog).findByText("Router future-family");
  const list = screen.getByLabelText("Built-in capabilities");
  expect(list).toHaveTextContent("Router social");
  expect(list).not.toHaveTextContent("Router future-family");
});
