import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import {
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
  userModelPreferenceContract,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function button(name: string, container: ParentNode = document.body) {
  const element = queryAllByRoleFast("button", container).find((candidate) => {
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

async function openPaidTools(path = "/?settings=tools") {
  context.mocks.data.org({
    id: "org_default",
    name: "Research team",
    role: "member",
  });
  await setupPage({
    context,
    path,
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: "org_default", name: "Research team" },
        memberships: [{ id: "org_default" }],
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  return screen.findByRole("dialog", { name: "Settings" });
}

function modelPreference(
  overrides: Partial<UserModelPreferenceResponse> = {},
): UserModelPreferenceResponse {
  return {
    selectedModel: null,
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: null,
    ...overrides,
  };
}

function imageModelSelect() {
  return screen.findByRole("combobox", { name: "Model" });
}

async function readySwitch(name: string) {
  const toggle = await screen.findByRole("switch", { name });
  await waitFor(() => {
    return expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  });
  return toggle;
}

test("Members manage Paid tools in Tools, separately from Chat", async () => {
  const dialog = await openPaidTools("/?settings=preference");
  click(button("Chat", dialog));
  expect(
    within(dialog).queryByRole("switch", { name: "Web search" }),
  ).not.toBeInTheDocument();
  click(button("Tools", dialog));
  const toggle = await readySwitch("Web search");
  expect(toggle).toBeChecked();
  expect(within(dialog).getAllByRole("switch")).toHaveLength(9);
  expect(
    within(dialog).getByText(
      "These settings apply only to you in Research team.",
    ),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(/Tasks already running or prepared/),
  ).toBeInTheDocument();
  expect(window.location.search).toContain("settings=tools");
  expect(
    queryAllByRoleFast("button", dialog).some((element) => {
      return element.textContent === "Tools";
    }),
  ).toBeTruthy();
});

test("A member without feature switches manages Paid tools in Tools", async () => {
  await setupPage({ context, path: "/?settings=tools" });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await within(dialog).findByRole("heading", { name: "Tools" });
  expect(button("Tools", dialog)).toBeInTheDocument();
  await expect(readySwitch("Web search")).resolves.toBeChecked();
});

test("Paid tools toggles save inverted enabled state and can re-enable a tool", async () => {
  const updates: { toolId: string; disabled: boolean }[] = [];
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["web-search"] });
  });
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    updates.push({ toolId: params.toolId, disabled: body.disabled });
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
  await openPaidTools();
  const toggle = await readySwitch("Web search");
  expect(toggle).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toBeChecked();
  });
  await readySwitch("Web search");
  click(toggle);
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
  expect(updates).toStrictEqual([
    { toolId: "web-search", disabled: false },
    { toolId: "web-search", disabled: true },
  ]);
});

test("A failed load shows no assumed enabled tools and can be retried", async () => {
  let available = false;
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return available
      ? respond(200, { disabledTools: ["web-search"] })
      : respond(500, {
          error: {
            message: "Preferences temporarily unavailable",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
  });
  const dialog = await openPaidTools();
  await within(dialog).findByText("Your tool settings could not be loaded.");
  expect(
    within(dialog).queryByRole("switch", { name: "Web search" }),
  ).not.toBeInTheDocument();
  available = true;
  click(button("Retry", dialog));
  await expect(readySwitch("Web search")).resolves.not.toBeChecked();
});

test("A workspace switch while a save obtains its token prevents sending that save under the new workspace", async () => {
  const tokenRequested = context.mocks.deferred<void>();
  const releaseToken = context.mocks.deferred<void>();
  const updates: string[] = [];
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    updates.push(params.toolId);
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
  await openPaidTools();
  const webSearch = await readySwitch("Web search");
  mockedClerk.sessionGetToken.mockImplementationOnce(async () => {
    tokenRequested.resolve();
    await releaseToken.promise;
    return "old-workspace-token";
  });
  click(webSearch);
  await tokenRequested.promise;
  act(() => {
    context.mocks.clerk().organization({
      activeOrg: { id: "org_second", name: "Second workspace" },
      memberships: [{ id: "org_second" }],
    });
    context.mocks.clerk().stateChanged();
  });
  releaseToken.resolve();
  await screen.findByText(
    "These settings apply only to you in Second workspace.",
  );
  await expect(readySwitch("Web search")).resolves.toBeChecked();
  expect(updates).toStrictEqual([]);
});

test("The image model shows the system default when the member has none", async () => {
  await openPaidTools();
  const select = await imageModelSelect();
  await waitFor(() => {
    return expect(select).toHaveTextContent("GPT Image 2.5 Flare");
  });
  await waitFor(() => {
    return expect(select).not.toBeDisabled();
  });
});

test("The image model shows the member's stored model", async () => {
  context.mocks.data.userModelPreference(
    modelPreference({ selectedImageModel: "fal-ai/flux-2-pro" }),
  );
  await openPaidTools();
  const select = await imageModelSelect();
  await waitFor(() => {
    return expect(select).toHaveTextContent("FLUX.2 Pro");
  });
});

test("The image model is locked but still shown while image generation is off", async () => {
  context.mocks.data.userModelPreference(
    modelPreference({ selectedImageModel: "ideogram/v4" }),
  );
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["image-generation"] });
  });
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
  await openPaidTools();
  const toggle = await readySwitch("Image generation");
  expect(toggle).not.toBeChecked();
  const select = await imageModelSelect();
  await waitFor(() => {
    return expect(select).toHaveTextContent("Ideogram 4");
  });
  expect(select).toBeDisabled();
  click(toggle);
  await waitFor(() => {
    return expect(select).not.toBeDisabled();
  });
  expect(select).toHaveTextContent("Ideogram 4");
});

test("Choosing an image model saves it with the stored run model", async () => {
  const updates: UpdateUserModelPreferenceRequest[] = [];
  context.mocks.data.userModelPreference(
    modelPreference({
      selectedModel: "claude-sonnet-5",
      serviceTier: "priority",
    }),
  );
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    updates.push(body);
    const stored = modelPreference({
      selectedModel: body.selectedModel,
      serviceTier: body.serviceTier,
      selectedImageModel: body.selectedImageModel ?? null,
      updatedAt: "2026-09-28T00:00:00.000Z",
    });
    context.mocks.data.userModelPreference(stored);
    return respond(200, stored);
  });
  await openPaidTools();
  const select = await imageModelSelect();
  await waitFor(() => {
    return expect(select).not.toBeDisabled();
  });
  const user = userEvent.setup();
  await user.click(select);
  await user.click(await screen.findByRole("option", { name: /^Ideogram 4/ }));
  await waitFor(() => {
    return expect(select).toHaveTextContent("Ideogram 4");
  });
  await waitFor(() => {
    return expect(select).not.toBeDisabled();
  });
  expect(updates).toStrictEqual([
    {
      selectedModel: "claude-sonnet-5",
      serviceTier: "priority",
      selectedImageModel: "ideogram/v4",
    },
  ]);
});

test("A failed image model save keeps the stored model and can be retried", async () => {
  let failing = true;
  const updates: UpdateUserModelPreferenceRequest[] = [];
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    updates.push(body);
    if (failing) {
      return respond(500, {
        error: {
          message: "Preferences temporarily unavailable",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    }
    const stored = modelPreference({
      selectedImageModel: body.selectedImageModel ?? null,
    });
    context.mocks.data.userModelPreference(stored);
    return respond(200, stored);
  });
  const dialog = await openPaidTools();
  const select = await imageModelSelect();
  await waitFor(() => {
    return expect(select).not.toBeDisabled();
  });
  const user = userEvent.setup();
  await user.click(select);
  await user.click(
    await screen.findByRole("option", { name: /^Nano Banana 2 Lite/ }),
  );
  await within(dialog).findByText("Your image model was not saved.");
  expect(select).toHaveTextContent("GPT Image 2.5 Flare");
  failing = false;
  click(button("Retry", dialog));
  await waitFor(() => {
    return expect(select).toHaveTextContent("Nano Banana 2 Lite");
  });
  expect(updates).toHaveLength(2);
  expect(updates[1]?.selectedImageModel).toBe("google/nano-banana-2-lite");
});

test("An image model change from another session refreshes the displayed model", async () => {
  await openPaidTools();
  const select = await imageModelSelect();
  await waitFor(() => {
    return expect(select).toHaveTextContent("GPT Image 2.5 Flare");
  });
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("userPreferenceChanged"),
    ).toBeTruthy();
  });
  context.mocks.data.userModelPreference(
    modelPreference({ selectedImageModel: "gpt-image-2" }),
  );
  act(() => {
    context.mocks.ably.trigger("userPreferenceChanged", {
      kinds: ["defaultImageModel"],
    });
  });
  await waitFor(() => {
    return expect(select).toHaveTextContent("GPT Image 2");
  });
  expect(select).not.toHaveTextContent("GPT Image 2.5 Flare");
});
