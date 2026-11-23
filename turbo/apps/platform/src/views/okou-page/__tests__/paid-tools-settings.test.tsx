import userEvent from "@testing-library/user-event";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { test, expect, vi } from "vitest";
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

async function pendingWorkspaceSave(field: "web search" | "image model") {
  const held = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const returned = context.mocks.deferred<void>();
  let saving = false;
  let token = "research-member";
  const toolWrites: string[] = [];
  const modelWrites: string[] = [];
  const disabled = new Set<string>();
  let model: ImageModel | null = "fal-ai/flux-2-pro";
  const clerk = context.mocks.clerk();
  mockedClerk.sessionGetToken.mockImplementation(async () => {
    const credential = token;
    if (field === "web search" && saving && !held.settled()) {
      held.resolve();
      await release.promise;
      returned.resolve();
    }
    return credential;
  });
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: [...disabled] });
  });
  context.mocks.api(
    paidToolsContract.update,
    ({ params, body, request, respond }) => {
      toolWrites.push(request.headers.get("authorization") ?? "");
      if (body.disabled) {
        disabled.add(params.toolId);
      }
      return respond(200, { toolId: params.toolId, disabled: body.disabled });
    },
  );
  context.mocks.api(userModelPreferenceContract.get, ({ respond }) => {
    return respond(200, {
      selectedModel: null,
      serviceTier: null,
      modelSettings: {},
      selectedImageModel: model,
      updatedAt: null,
    });
  });
  context.mocks.api(
    userModelPreferenceContract.update,
    ({ body, request, respond }) => {
      modelWrites.push(request.headers.get("authorization") ?? "");
      model = body.selectedImageModel ?? null;
      return respond(200, {
        selectedModel: null,
        serviceTier: null,
        modelSettings: {},
        selectedImageModel: model,
        updatedAt: null,
      });
    },
  );
  const read = Response.prototype.json;
  vi.spyOn(Response.prototype, "json").mockImplementation(async function (
    this: Response,
  ) {
    const data: unknown = await read.call(this);
    if (
      saving &&
      field === "image model" &&
      !held.settled() &&
      new URL(this.url).pathname === userModelPreferenceContract.get.path
    ) {
      held.resolve();
      await release.promise;
      returned.resolve();
    }
    return data;
  });
  const settings = await openTools();
  const tools = within(settings);
  const web = await tools.findByRole("switch", { name: "Web search" });
  const modelControl = await tools.findByRole("combobox", { name: "Model" });
  await waitFor(() => {
    return expect(modelControl).toHaveTextContent("FLUX.2 Pro");
  });
  expect(web).toBeChecked();
  saving = true;
  if (field === "image model") {
    await selectModel(settings, /Ideogram 4/);
  } else {
    click(web);
  }
  await held.promise;
  await tools.findByText("Saving…");
  async function switchToSecondWorkspace() {
    token = "second-member";
    clerk.organization({
      activeOrg: { id: "org_second", name: "Second workspace" },
      memberships: [{ id: "org_second" }],
    });
    clerk.stateChanged();
    await tools.findByText(
      "These settings apply only to you in Second workspace.",
    );
  }
  async function deliver() {
    release.resolve();
    await returned.promise;
  }
  return {
    tools,
    toolWrites,
    modelWrites,
    returned,
    switchToSecondWorkspace,
    deliver,
  };
}

test.each([
  ["paid-tools-settings-014", "web search", "release"],
  ["Withheld control", "web search", "hold"],
  ["paid-tools-settings-023", "image model", "release"],
  ["Withheld control", "image model", "hold"],
] as const)(
  "%s %s in the second workspace while the previous request is set to %s",
  async (_label, field, delivery) => {
    const pending = await pendingWorkspaceSave(field);
    await pending.switchToSecondWorkspace();
    if (delivery === "release") {
      await pending.deliver();
    }
    const current = pending.tools.getByRole("combobox", { name: "Model" });
    await waitFor(() => {
      return expect(current).toBeEnabled();
    });
    click(current);
    await screen.findByRole("option", { name: /Ideogram 4/ });
    expect(
      pending.tools.getByRole("switch", { name: "Web search" }),
    ).toBeChecked();
    expect(pending.toolWrites).toStrictEqual([]);
    expect(pending.modelWrites).toStrictEqual([]);
    expect(pending.returned.settled()).toBe(delivery === "release");
  },
);

test.each(["web search", "image model"] as const)(
  "Original workspace control %s sends the held change with its own credential",
  async (field) => {
    const pending = await pendingWorkspaceSave(field);
    await pending.deliver();
    const writes =
      field === "web search" ? pending.toolWrites : pending.modelWrites;
    await waitFor(() => {
      return expect(writes).toContain("Bearer research-member");
    });
  },
);

async function pendingImageWrite() {
  const entered = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const issued = context.mocks.deferred<void>();
  const rechecked = context.mocks.deferred<string>();
  const organization = Object.getOwnPropertyDescriptor(
    mockedClerk,
    "organization",
  )!.get!;
  let watchOwner = false;
  vi.spyOn(mockedClerk, "organization", "get").mockImplementation(() => {
    const value = organization.call(
      mockedClerk,
    ) as typeof mockedClerk.organization;
    if (watchOwner && value && !rechecked.settled()) {
      rechecked.resolve(value.id);
    }
    return value;
  });
  const saved = context.mocks.deferred<ImageModel | null>();
  const savedModels = new Map<string, ImageModel | null>([
    ["Bearer teams-A", "fal-ai/flux-2-pro"],
    ["Bearer teams-B", null],
  ]);
  let credential = "teams-A";
  let selecting = false;
  let holdWrite = false;
  const identity = context.mocks.clerk();
  mockedClerk.sessionGetToken.mockImplementation(async () => {
    const current = credential;
    if (holdWrite && current === "teams-A") {
      holdWrite = false;
      entered.resolve();
      await release.promise;
      issued.resolve();
    }
    return current;
  });
  const projection = (value: ImageModel | null) => {
    return {
      selectedModel: null,
      serviceTier: null,
      modelSettings: {},
      selectedImageModel: value,
      updatedAt: null,
    };
  };
  context.mocks.api(userModelPreferenceContract.get, ({ request, respond }) => {
    const auth = request.headers.get("Authorization") ?? "";
    if (selecting && auth === "Bearer teams-A") {
      holdWrite = true;
      selecting = false;
    }
    return respond(200, projection(savedModels.get(auth) ?? null));
  });
  context.mocks.api(
    userModelPreferenceContract.update,
    ({ request, body, respond }) => {
      const value = body.selectedImageModel ?? null;
      savedModels.set(request.headers.get("Authorization") ?? "", value);
      saved.resolve(value);
      return respond(200, projection(value));
    },
  );
  const panel = await openTools();
  const controls = within(panel);
  const picker = await controls.findByRole("combobox", { name: "Model" });
  await waitFor(() => {
    return expect(picker).toHaveTextContent("FLUX.2 Pro");
  });
  selecting = true;
  await selectModel(panel, /Ideogram 4/);
  await entered.promise;
  await controls.findByText("Saving…");
  async function switchWorkspace() {
    credential = "teams-B";
    identity.organization({
      activeOrg: { id: "org_beta", name: "Second workspace" },
      memberships: [{ id: "org_beta" }],
    });
    identity.stateChanged();
    await controls.findByText(
      "These settings apply only to you in Second workspace.",
    );
    const fresh = await controls.findByRole("combobox", { name: "Model" });
    await waitFor(() => {
      return expect(fresh).toBeEnabled();
    });
    click(fresh);
    await screen.findByRole("option", { name: /Ideogram 4/ });
    watchOwner = true;
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      return expect(screen.queryByRole("listbox")).toBeNull();
    });
    expect(rechecked.settled()).toBeFalsy();
  }
  async function deliver() {
    release.resolve();
    await issued.promise;
  }
  return {
    controls,
    savedModels,
    saved,
    release,
    deliver,
    switchWorkspace,
    rechecked,
  };
}

test("Original workspace control sends the selected image model after the write credential arrives", async () => {
  const save = await pendingImageWrite();
  await save.deliver();
  await expect(save.saved.promise).resolves.toBe("ideogram/v4");
  expect(save.savedModels.get("Bearer teams-A")).toBe("ideogram/v4");
  await waitFor(() => {
    return expect(
      save.controls.getByRole("combobox", { name: "Model" }),
    ).toBeEnabled();
  });
});
test.each([
  ["paid-tools-settings-024", "deliver"],
  ["Withheld workspace credential control", "withhold"],
] as const)(
  "%s a pending image write is scoped to its original workspace (%s)",
  async (_id, delivery) => {
    const pending = await pendingImageWrite();
    try {
      await pending.switchWorkspace();
      let observed: string | null = null;
      if (delivery === "deliver") {
        await pending.deliver();
        observed = await Promise.race([
          pending.rechecked.promise,
          pending.saved.promise,
        ]);
      }
      expect(observed).toBe(delivery === "deliver" ? "org_beta" : null);
      expect(pending.rechecked.settled()).toBe(delivery === "deliver");
      expect(pending.savedModels.get("Bearer teams-A")).toBe(
        "fal-ai/flux-2-pro",
      );
      expect(pending.savedModels.get("Bearer teams-B")).toBeNull();
    } finally {
      if (!pending.release.settled()) {
        pending.release.resolve();
      }
    }
  },
);
