import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { HttpResponse } from "msw";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function startResearch() {
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  await clickComposerAddMenuItem("Research");
}
async function panel() {
  click(await findFastControl("button", "Tools"));
  return await screen.findByRole("dialog", { name: "Built-in tools" });
}
function setting(panel: HTMLElement, name: string) {
  return within(panel).findByRole("switch", { name });
}
async function toggle(control: HTMLElement, enabled: boolean) {
  click(control);
  await waitFor(() => {
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAttribute("aria-checked", String(enabled));
  });
}
test("composer-tools-001 settings and the composer reflect confirmed independent changes to two tool preferences", async () => {
  await startResearch();
  const tools = await panel();
  const web = await setting(tools, "Web search"),
    finance = await setting(tools, "Financial data");
  expect(web).toBeChecked();
  expect(finance).toBeChecked();
  await toggle(web, false);
  await toggle(finance, false);
  await userEvent.keyboard("{Escape}");
  click(await screen.findByLabelText("Test User"));
  const menu = await screen.findByRole("menu");
  click(await within(menu).findByText("Settings"));
  const settings = await screen.findByRole("dialog");
  click(await within(settings).findByText("Tools", { exact: true }));
  const settingsWeb = await setting(settings, "Web search");
  expect(settingsWeb).not.toBeChecked();
  await expect(setting(settings, "Financial data")).resolves.not.toBeChecked();
  await toggle(settingsWeb, true);
  await userEvent.keyboard("{Escape}");
  const reopened = await panel();
  await expect(setting(reopened, "Web search")).resolves.toBeChecked();
  await expect(setting(reopened, "Financial data")).resolves.not.toBeChecked();
});
test("composer-tools-002 the pending switch survives reopening, reports its own failure and permits retry", async () => {
  const delivery = context.mocks.deferred<void>(),
    requested = context.mocks.deferred<void>();
  let fail = true;
  const disabled = new Set<string>();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: [...disabled] });
  });
  context.mocks.api(
    paidToolsContract.update,
    async ({ params, body, respond }) => {
      if (fail) {
        requested.resolve();
        await delivery.promise;
        return respond(500, {
          error: { code: "UNAVAILABLE", message: "Try later" },
        });
      }
      if (body.disabled) {
        disabled.add(params.toolId);
      }
      return respond(200, { toolId: params.toolId, disabled: body.disabled });
    },
  );
  await startResearch();
  const first = await panel();
  click(await setting(first, "Web search"));
  await requested.promise;
  click(await findFastControl("button", "Tools"));
  await waitFor(() => {
    expect(first).not.toBeInTheDocument();
  });
  const next = await panel();
  const web = await setting(next, "Web search");
  expect(web).toHaveAttribute("aria-disabled", "true");
  const finance = await setting(next, "Financial data");
  expect(finance).not.toHaveAttribute("aria-disabled", "true");
  expect(finance).toBeChecked();
  delivery.resolve();
  await within(next).findByText("Your change was not saved.");
  expect(web).not.toHaveAttribute("aria-disabled", "true");
  expect(web).toBeChecked();
  fail = false;
  await toggle(web, false);
});
test("composer-tools-005 web preferences survive a catalog failure and reopening discovers the new research family", async () => {
  let restored = false;
  const family = {
    id: "new-research",
    title: { "en-US": "New research" },
    description: { "en-US": "Find local research" },
    summary: "Find local research",
  };
  for (const url of [
    "https://data.okou.ai/mcp",
    "https://okou-data-router-staging.vm0.workers.dev/mcp",
  ]) {
    context.mocks.http.post(url, async ({ request }) => {
      const msg = (await request.json()) as { id: number };
      return restored
        ? HttpResponse.json({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "research_lookup",
                  inputSchema: { type: "object", properties: {} },
                  _meta: { "ai.okou/data": { family: family.id } },
                },
              ],
              _meta: { "ai.okou/data": { families: [family] } },
            },
          })
        : new HttpResponse(null, { status: 503 });
    });
  }
  await startResearch();
  const first = await panel();
  await within(first).findByText("Your tool settings could not be loaded.");
  await toggle(await setting(first, "Web search"), false);
  restored = true;
  click(await findFastControl("button", "Tools"));
  await waitFor(() => {
    expect(first).not.toBeInTheDocument();
  });
  const next = await panel();
  await expect(setting(next, "New research")).resolves.toBeChecked();
  await expect(setting(next, "Web search")).resolves.not.toBeChecked();
});
