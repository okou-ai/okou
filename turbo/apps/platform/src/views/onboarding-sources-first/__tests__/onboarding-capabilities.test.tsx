import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { screen, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { mockOnboardingConnectorCatalog } from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const TITLE = "More ways to get your work done";
const READY_TITLE = "Let’s start your first task";
const FAMILY_IDS = Object.freeze([
  "web-extraction",
  "company-contacts",
  "web-search",
  "social",
  "finance",
  "places-weather",
]);

/** An external catalog; Router's web-search family is shown as Okou's own row. */
function mockCatalog(families: readonly string[] = FAMILY_IDS, status = 200) {
  for (const url of [
    "https://data.okou.ai/mcp",
    "https://okou-data-router-staging.vm0.workers.dev/mcp",
  ]) {
    context.mocks.http.post(url, async ({ request }) => {
      const message = (await request.json()) as { id: unknown };
      return HttpResponse.json(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: families.map((id) => {
              return {
                name: `${id}_tool`,
                inputSchema: { type: "object" },
                _meta: { "ai.okou/data": { family: id } },
              };
            }),
            _meta: {
              "ai.okou/data": {
                families: families.map((id) => {
                  return {
                    id,
                    title: { "en-US": `Router ${id}` },
                    description: { "en-US": `Research with ${id}.` },
                  };
                }),
              },
            },
          },
        },
        { status },
      );
    });
  }
}

function button(name: string) {
  const element = queryAllByRoleFast("button").find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!element) {
    throw new Error(`Button not found: ${name}`);
  }
  return element;
}

async function openCapabilities({ isAdmin = true } = {}) {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin,
  });
  mockOnboardingConnectorCatalog(context, []);
  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboardingCapabilities}?redeemCode=LAUNCH50`,
  });
}

test("All capabilities can be off and the task and separate output format survive navigation", async () => {
  mockCatalog();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["image-generation", ...FAMILY_IDS] });
  });
  await openCapabilities();
  const list = await screen.findByRole("list", {
    name: "Built-in capabilities",
  });
  for (const toggle of within(list).getAllByRole("switch")) {
    expect(toggle).not.toBeChecked();
  }
  click(button("Back"));
  await screen.findByRole("heading", { name: "Keep Okou a message away" });
  click(button("Not now"));
  await screen.findByRole("heading", { name: TITLE });
  click(button("Continue"));
  await screen.findByRole("heading", { name: READY_TITLE });
  const prompt = await screen.findByLabelText("Your first task");
  const task = "Draft a launch plan for my business.";
  await fill(prompt, task);
  click(button("Presentation"));
  expect(prompt).toHaveValue(task);
  expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
  click(button("Back"));
  await screen.findByRole("heading", { name: TITLE });
  click(button("Continue"));
  await expect(screen.findByLabelText("Your first task")).resolves.toHaveValue(
    task,
  );
  expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
});

test("Catalog failure does not block onboarding", async () => {
  mockCatalog([], 500);
  await openCapabilities();
  await screen.findByText("Your tool settings could not be loaded.");
  click(button("Continue"));
  await screen.findByRole("heading", { name: READY_TITLE });
  expect(pathname()).toBe(ROUTES.onboardingReady);
});

test.each([true, false])(
  "All new users choose capabilities after chat channels (isAdmin=%s)",
  async (isAdmin) => {
    await openCapabilities({ isAdmin });
    await screen.findByRole("heading", { name: TITLE });
    click(button("Back"));
    await screen.findByRole("heading", { name: "Keep Okou a message away" });
    click(button("Not now"));
    await screen.findByRole("heading", { name: TITLE });
    expect(pathname()).toBe(ROUTES.onboardingCapabilities);
    click(button("Continue"));
    await screen.findByRole("heading", { name: READY_TITLE });
    expect(pathname()).toBe(ROUTES.onboardingReady);
  },
);

test("Opening Settings does not replace the onboarding catalog", async () => {
  mockCatalog();
  await openCapabilities();
  const list = await screen.findByRole("list", {
    name: "Built-in capabilities",
  });
  mockCatalog(["future-family"]);
  click(button("Test User"));
  const settings = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim() === "Settings";
  });
  if (!settings) {
    throw new Error("Settings menu item not found");
  }
  click(settings);
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const tools = queryAllByRoleFast("button", dialog).find((candidate) => {
    return candidate.textContent?.trim() === "Tools";
  });
  if (!tools) {
    throw new Error("Tools section not found");
  }
  click(tools);
  await within(dialog).findByRole("switch", { name: "Router future-family" });
  expect(
    within(list).getByRole("switch", { name: "Router social", hidden: true }),
  ).toBeInTheDocument();
  expect(
    within(list).queryByText("Router future-family"),
  ).not.toBeInTheDocument();
});
