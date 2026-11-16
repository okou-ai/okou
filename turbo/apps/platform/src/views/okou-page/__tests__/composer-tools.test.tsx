import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  paidToolsContract,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { AGENT_ID } from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();

function button(name: string, container: ParentNode = document.body) {
  const result = queryAllByRoleFast("button", container).find((item) => {
    return (
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === name
    );
  });
  if (!result) {
    throw new Error(`Expected button ${name}`);
  }
  return result;
}

async function setupPeopleSearch() {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.HomeCapabilities]: true },
  });
  const people = await screen.findByRole("region", { name: "Find people" });
  click(button("Explore", people));
  await screen.findByRole("tablist", { name: "Explore Okou capabilities" });
}

function openTools() {
  click(button("Tools"));
  return screen.findByRole("dialog", { name: "Built-in tools" });
}

async function readySwitch(name: string, container: HTMLElement) {
  const toggle = await within(container).findByRole("switch", { name });
  await waitFor(() => {
    expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  });
  return toggle;
}

function mockPreferences() {
  let disabledTools: PaidToolId[] = [];
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools });
  });
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    disabledTools = disabledTools.filter((toolId) => {
      return toolId !== params.toolId;
    });
    if (body.disabled) {
      disabledTools.push(params.toolId);
    }
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
}

test("Composer tools and Settings share saved search preferences", async () => {
  mockPreferences();
  await setupPeopleSearch();
  const popup = await openTools();
  const search = await readySwitch("Web search", popup);
  const finance = await readySwitch("Financial data", popup);
  expect(search).toBeChecked();
  expect(finance).toBeChecked();
  click(search);
  await waitFor(() => {
    expect(search).not.toBeChecked();
  });
  click(finance);
  await waitFor(() => {
    expect(finance).not.toBeChecked();
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(button("Tools")).toHaveFocus();
  });
  const rail = screen.getByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Test User"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(button("Tools", settings));
  await expect(readySwitch("Web search", settings)).resolves.not.toBeChecked();
  await expect(
    readySwitch("Financial data", settings),
  ).resolves.not.toBeChecked();
  click(await readySwitch("Web search", settings));
  await waitFor(() => {
    expect(
      within(settings).getByRole("switch", { name: "Web search" }),
    ).toBeChecked();
  });
  click(button("Close", settings));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
  const reopened = await openTools();
  await expect(readySwitch("Web search", reopened)).resolves.toBeChecked();
  await expect(
    readySwitch("Financial data", reopened),
  ).resolves.not.toBeChecked();
});

test("Closing and reopening Tools retains a pending save and its retryable failure", async () => {
  const releaseSave = context.mocks.deferred<void>();
  let fail = true;
  let disabledTools: PaidToolId[] = [];
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools });
  });
  context.mocks.api(
    paidToolsContract.update,
    async ({ params, body, respond }) => {
      if (fail) {
        await releaseSave.promise;
        fail = false;
        return respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Save unavailable" },
        });
      }
      disabledTools = [params.toolId];
      return respond(200, { toolId: params.toolId, disabled: body.disabled });
    },
  );
  await setupPeopleSearch();
  const popup = await openTools();
  click(await readySwitch("Web search", popup));
  await within(popup).findByText("Saving…");
  await userEvent.keyboard("{Escape}");
  const reopened = await openTools();
  const search = await within(reopened).findByRole("switch", {
    name: "Web search",
  });
  expect(search).toHaveAttribute("aria-disabled", "true");
  await expect(readySwitch("Financial data", reopened)).resolves.toBeChecked();
  releaseSave.resolve();
  await within(reopened).findByRole("alert");
  await readySwitch("Web search", reopened);
  expect(search).toBeChecked();
  click(search);
  await waitFor(() => {
    expect(search).not.toBeChecked();
  });
});

test.each(["initial read", "confirmation read"])(
  "Reopening Tools recovers a failed preference %s",
  async (failure) => {
    let failRead = failure === "initial read";
    let failed = false;
    let disabledTools: PaidToolId[] = [];
    context.mocks.api(paidToolsContract.get, ({ respond }) => {
      if (failRead) {
        failed = true;
        return respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Read unavailable" },
        });
      }
      return respond(200, { disabledTools });
    });
    context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
      disabledTools = body.disabled ? [params.toolId] : [];
      if (failure === "confirmation read" && !failed) {
        failRead = true;
      }
      return respond(200, { toolId: params.toolId, disabled: body.disabled });
    });
    await setupPeopleSearch();
    const popup = await openTools();
    if (failure === "confirmation read") {
      click(await readySwitch("Web search", popup));
    }
    await within(popup).findByRole("alert");
    await userEvent.keyboard("{Escape}");
    failRead = false;
    const reopened = await openTools();
    const search = await readySwitch("Web search", reopened);
    expect(search).toHaveAttribute(
      "aria-checked",
      failure === "initial read" ? "true" : "false",
    );
    click(search);
    await waitFor(() => {
      expect(search).toHaveAttribute(
        "aria-checked",
        failure === "initial read" ? "false" : "true",
      );
    });
  },
);

test("A failed tool catalog leaves Web search usable and retries on reopening", async () => {
  mockPreferences();
  let fail = true;
  for (const url of [
    "https://data.okou.ai/mcp",
    "https://okou-data-router-staging.vm0.workers.dev/mcp",
  ]) {
    context.mocks.http.post(url, async ({ request }) => {
      const message = (await request.json()) as { id: unknown };
      return fail
        ? HttpResponse.json({ error: "Unavailable" }, { status: 503 })
        : HttpResponse.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "new_research",
                  inputSchema: { type: "object" },
                  _meta: { "ai.okou/data": { family: "new-research" } },
                },
              ],
              _meta: {
                "ai.okou/data": {
                  families: [
                    {
                      id: "new-research",
                      title: { "en-US": "New research" },
                      description: { "en-US": "Research new sources." },
                    },
                  ],
                },
              },
            },
          });
    });
  }
  await setupPeopleSearch();
  const popup = await openTools();
  await within(popup).findByRole("alert");
  const search = await readySwitch("Web search", popup);
  click(search);
  await waitFor(() => {
    expect(search).not.toBeChecked();
  });
  await userEvent.keyboard("{Escape}");
  fail = false;
  const reopened = await openTools();
  await expect(readySwitch("New research", reopened)).resolves.toBeChecked();
  await expect(readySwitch("Web search", reopened)).resolves.not.toBeChecked();
});
