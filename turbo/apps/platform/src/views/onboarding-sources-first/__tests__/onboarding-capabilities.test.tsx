import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { mockOnboardingConnectorCatalog } from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const TITLE = "Meet Okou’s secret tools";
const READY_TITLE = "Start with a task that matters";
const FAMILY_IDS = Object.freeze([
  "finance",
  "maps",
  "seo",
  "scrape",
  "data-search",
  "people-search",
  "web-search",
  "social",
]);

/** An external catalog whose order differs from the onboarding presentation. */
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

test.each([false, true])(
  "Capabilities educate with image and social first (mobile=%s)",
  async (mobile) => {
    context.mocks.browser.matchMedia((query) => {
      return mobile && query === "(width < 640px)";
    });
    mockCatalog();
    await openCapabilities();
    await screen.findByRole("heading", { name: TITLE });
    const list = await screen.findByRole("list", {
      name: "Built-in capabilities",
    });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(9);
    const image = within(list).getByRole("switch", {
      name: "Image generation",
    });
    const social = within(list).getByRole("switch", { name: "Social search" });
    expect(within(list).getAllByRole("switch").slice(0, 2)).toStrictEqual([
      image,
      social,
    ]);
    expect(image).toBeChecked();
    expect(social).toBeChecked();
    expect(
      within(list).getAllByRole("switch", { name: "Web search" }),
    ).toHaveLength(1);
    expect(
      screen.getByText(
        "Research creators, posts, and engagement to guide your content.",
      ),
    ).toBeInTheDocument();
    for (const progress of screen.getAllByRole("progressbar")) {
      expect(progress).toHaveAttribute("aria-valuenow", "5");
      expect(progress).toHaveAttribute("aria-valuemax", "6");
    }
  },
);

test("A member's saved choice stays visible while saving and survives Back", async () => {
  mockCatalog();
  let disabledTools = ["social"];
  let saved = false;
  const refreshing = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(paidToolsContract.get, async ({ respond, withSignal }) => {
    if (saved && !release.settled()) {
      refreshing.resolve();
      await withSignal(release.promise);
    }
    return respond(200, { disabledTools });
  });
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    expect(params.toolId).toBe("social");
    expect(body.disabled).toBeFalsy();
    disabledTools = [];
    saved = true;
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
  await openCapabilities({ isAdmin: false });
  const social = await screen.findByRole("switch", { name: "Social search" });
  expect(social).not.toBeChecked();
  click(social);
  await refreshing.promise;
  try {
    expect(social).toBeInTheDocument();
    expect(social).not.toBeChecked();
    expect(button("Continue")).toHaveAttribute("aria-disabled", "true");
    click(button("Continue"));
    expect(pathname()).toBe(ROUTES.onboardingCapabilities);
  } finally {
    release.resolve();
  }
  await waitFor(() => {
    expect(social).toBeChecked();
    expect(social).not.toHaveAttribute("aria-disabled", "true");
  });
  click(button("Continue"));
  await screen.findByRole("heading", { name: READY_TITLE });
  expect(new URLSearchParams(search()).get("redeemCode")).toBe("LAUNCH50");
  click(button("Back"));
  await expect(
    screen.findByRole("switch", { name: "Social search" }),
  ).resolves.toBeChecked();
});

test("A failed preference update retains the previous choice and can be retried", async () => {
  mockCatalog();
  let fail = true;
  let disabledTools: string[] = [];
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools });
  });
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    if (fail) {
      fail = false;
      return respond(500, {
        error: { message: "Unavailable", code: "INTERNAL_SERVER_ERROR" },
      });
    }
    disabledTools = [params.toolId];
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
  await openCapabilities();
  const image = await screen.findByRole("switch", { name: "Image generation" });
  click(image);
  await screen.findByText("Your change was not saved.");
  expect(image).toBeChecked();
  click(image);
  await waitFor(() => {
    expect(image).not.toBeChecked();
    expect(
      screen.queryByText("Your change was not saved."),
    ).not.toBeInTheDocument();
  });
});

test("All capabilities can be off and the editable prompt and output format survive navigation", async () => {
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
  const prompt = await screen.findByLabelText("Your starting prompt");
  await fill(prompt, "Draft a launch plan for my business.");
  click(button("Presentation"));
  if (!(prompt instanceof HTMLTextAreaElement)) {
    throw new Error("Expected the starting prompt textarea");
  }
  const edited = prompt.value;
  expect(edited).toContain("Draft a launch plan for my business.");
  expect(edited).toContain("concise presentation");
  click(button("Back"));
  await screen.findByRole("heading", { name: TITLE });
  click(button("Continue"));
  await expect(
    screen.findByLabelText("Your starting prompt"),
  ).resolves.toHaveValue(edited);
  expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
});

test("New Router families use their published text and unavailable families stay hidden", async () => {
  mockCatalog(["future-family"]);
  await openCapabilities();
  const toggle = await screen.findByRole("switch", {
    name: "Router future-family",
  });
  expect(screen.getByText("Research with future-family.")).toBeInTheDocument();
  expect(
    screen.queryByRole("switch", { name: "Social search" }),
  ).not.toBeInTheDocument();
  click(toggle);
  await waitFor(() => {
    expect(toggle).not.toBeChecked();
  });
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
    within(list).getByRole("switch", { name: "Social search", hidden: true }),
  ).toBeInTheDocument();
  expect(
    within(list).queryByText("Router future-family"),
  ).not.toBeInTheDocument();
});
