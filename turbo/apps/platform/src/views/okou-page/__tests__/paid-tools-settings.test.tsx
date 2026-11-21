import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { test, expect } from "vitest";
import {
  click,
  holdElementAnimations,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
async function openTools() {
  const research = { id: "org_default", name: "Research team" };
  context.mocks.data.org({ ...research, role: "member" });
  await setupPage({
    context,
    path: "/?settings=preference",
    auth: {
      user: { id: "test-user-123", fullName: "Mira Lane" },
      organization: { activeOrg: research, memberships: [{ id: research.id }] },
    },
  });
  const settings = await screen.findByRole("dialog");
  await within(settings).findByRole("heading", { name: "Preference" });
  click(getAction("button", "Tools", settings));
  return settings;
}
function storedModel(selectedImageModel: ImageModel | null) {
  context.mocks.data.userModelPreference({
    selectedModel: null,
    serviceTier: null,
    modelSettings: {},
    selectedImageModel,
    updatedAt: null,
  });
}
function rejectImageSave() {
  context.mocks.api(userModelPreferenceContract.update, ({ respond }) => {
    return respond(500, {
      error: { code: "SAVE_FAILED", message: "Preference service unavailable" },
    });
  });
}
async function selectModel(settings: HTMLElement, name: RegExp) {
  const picker = await within(settings).findByRole("combobox", {
    name: "Model",
  });
  await waitFor(() => {
    return expect(picker).toBeEnabled();
  });
  click(picker);
  click(await screen.findByRole("option", { name }));
  return picker;
}
test("paid-tools-settings-001 opening Tools explains which member and future runs the settings affect", async () => {
  const settings = await openTools();
  const tools = within(settings);
  await tools.findByRole("switch", { name: "Financial data" });
  expect(tools.getByRole("switch", { name: "Web search" })).toBeChecked();
  expect(
    tools.getByText("These settings apply only to you in Research team."),
  ).toBeInTheDocument();
  expect(
    tools.getByText(
      "Changes apply to future runs. Tasks already running or prepared may keep their previous settings.",
    ),
  ).toBeInTheDocument();
  expect(new URL(location.href).searchParams.get("settings")).toBe("tools");
});
test("paid-tools-settings-003 only Image generation is locked during its confirmation read", async () => {
  const confirmation = context.mocks.deferred<void>();
  const reading = context.mocks.deferred<void>();
  let imageOff = false;
  context.mocks.api(paidToolsContract.get, async ({ respond }) => {
    if (imageOff) {
      reading.resolve();
      await confirmation.promise;
    }
    return respond(200, {
      disabledTools: imageOff ? ["finance", "image-generation"] : ["finance"],
    });
  });
  context.mocks.api(paidToolsContract.update, ({ body, params, respond }) => {
    imageOff = body.disabled;
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
  const settings = await openTools();
  const tool = within(settings);
  const image = await tool.findByRole("switch", { name: "Image generation" });
  const model = tool.getByRole("combobox", { name: "Model" });
  const checkOthers = () => {
    for (const name of [
      "Web search",
      "Advanced data research",
      "People search",
    ]) {
      const toggle = tool.getByRole("switch", { name });
      expect(toggle).toBeChecked();
      expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    }
    const finance = tool.getByRole("switch", { name: "Financial data" });
    expect(finance).not.toBeChecked();
    expect(finance).not.toHaveAttribute("aria-disabled", "true");
  };
  await waitFor(() => {
    return expect(model).toBeEnabled();
  });
  expect(image).toBeChecked();
  checkOthers();
  click(image);
  await reading.promise;
  await tool.findByText("Saving…");
  expect(image).toHaveAttribute("aria-disabled", "true");
  expect(model).toBeEnabled();
  checkOthers();
  confirmation.resolve();
  await waitFor(() => {
    return expect(model).toBeDisabled();
  });
  expect(image).not.toBeChecked();
  expect(image).not.toHaveAttribute("aria-disabled", "true");
  checkOthers();
  click(image);
  await waitFor(() => {
    return expect(model).toBeEnabled();
  });
  expect(image).toBeChecked();
});
test("paid-tools-settings-008 closing Settings abandons discovery before exit and reopening loads the new catalog", async () => {
  const pending = context.mocks.deferred<void>();
  const started = context.mocks.deferred<void>();
  const cancelled = context.mocks.deferred<void>();
  let fresh = false;
  context.mocks.http.post(/\/mcp$/u, async ({ request }) => {
    const title = fresh ? "Current archive" : "Retired archive";
    if (!fresh) {
      request.signal.addEventListener(
        "abort",
        () => {
          return cancelled.resolve();
        },
        {
          once: true,
        },
      );
      started.resolve();
      await pending.promise;
    }
    return HttpResponse.json({
      result: {
        tools: [
          {
            name: "find_archive",
            inputSchema: { type: "object" },
            _meta: { "ai.okou/data": { family: "archives" } },
          },
        ],
        _meta: {
          "ai.okou/data": {
            families: [
              {
                id: "archives",
                title: { "en-US": title },
                description: { "en-US": "Archived material" },
                summary: "Archived material",
              },
            ],
          },
        },
      },
    });
  });
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["archives"] });
  });
  const settings = await openTools();
  await started.promise;
  const finishExit = holdElementAnimations(settings);
  click(getAction("button", "Close", settings));
  await cancelled.promise;
  expect(settings).toBeInTheDocument();
  expect(new URL(location.href).searchParams.has("settings")).toBeFalsy();
  fresh = true;
  pending.resolve();
  finishExit();
  await waitFor(() => {
    return expect(settings).not.toBeInTheDocument();
  });
  click(await findAction("button", "Mira Lane"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  const reopened = await screen.findByRole("dialog");
  click(await findAction("button", "Tools", reopened));
  const view = within(reopened);
  await expect(
    view.findByRole("switch", { name: "Current archive" }),
  ).resolves.not.toBeChecked();
  expect(view.queryByRole("switch", { name: "Retired archive" })).toBeNull();
  expect(view.getByRole("switch", { name: "Web search" })).toBeChecked();
});

test.each([
  { id: "paid-tools-settings-015", saved: null, label: "GPT Image 2.5 Flare" },
  {
    id: "paid-tools-settings-016",
    saved: "fal-ai/flux-2-pro",
    label: "FLUX.2 Pro",
  },
] as const)(
  "$id opening Tools displays $label for the member’s saved preference",
  async ({ saved, label }) => {
    storedModel(saved);
    const view = within(await openTools());
    const picker = await view.findByRole("combobox", { name: "Model" });
    await waitFor(() => {
      return expect(picker).toHaveTextContent(label);
    });
    expect(picker).toBeEnabled();
  },
);
test("paid-tools-settings-017 enabling image generation restores the picker with the member’s Ideogram choice", async () => {
  storedModel("ideogram/v4");
  let disabled = true;
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, {
      disabledTools: disabled ? ["image-generation"] : [],
    });
  });
  context.mocks.api(paidToolsContract.update, ({ respond, params, body }) => {
    disabled = body.disabled;
    return respond(200, { toolId: params.toolId, disabled });
  });
  const view = within(await openTools());
  const model = await view.findByRole("combobox", { name: "Model" });
  await waitFor(() => {
    return expect(model).toHaveTextContent("Ideogram 4");
  });
  expect(model).toBeDisabled();
  click(view.getByRole("switch", { name: "Image generation" }));
  await waitFor(() => {
    return expect(model).toBeEnabled();
  });
  expect(model).toHaveTextContent("Ideogram 4");
});
test("paid-tools-settings-019 a failed preference write leaves Nano Banana 2 Lite selected and explains the failure", async () => {
  rejectImageSave();
  const settings = await openTools();
  const model = await selectModel(settings, /Nano Banana 2 Lite/u);
  await within(settings).findByText("Your image model was not saved.");
  expect(model).toHaveTextContent("Nano Banana 2 Lite");
});
test("paid-tools-settings-020 disabling image generation discards an unsaved Ideogram choice and clears its error", async () => {
  rejectImageSave();
  const settings = await openTools();
  const model = await selectModel(settings, /Ideogram 4/u);
  const view = within(settings);
  await view.findByText("Your image model was not saved.");
  expect(model).toHaveTextContent("Ideogram 4");
  click(view.getByRole("switch", { name: "Image generation" }));
  await waitFor(() => {
    return expect(model).toBeDisabled();
  });
  expect(model).toHaveTextContent("GPT Image 2.5 Flare");
  expect(view.queryByText("Your image model was not saved.")).toBeNull();
});
test("paid-tools-settings-022 a model choice from another session replaces the default in the open picker", async () => {
  const view = within(await openTools());
  const model = await view.findByRole("combobox", { name: "Model" });
  await waitFor(() => {
    return expect(model).toHaveTextContent("GPT Image 2.5 Flare");
  });
  storedModel("gpt-image-2");
  context.mocks.ably.trigger("userPreferenceChanged", {
    kinds: ["defaultImageModel"],
  });
  await waitFor(() => {
    return expect(model).toHaveTextContent(/^GPT Image 2$/u);
  });
});
