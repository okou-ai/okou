import {
  act,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { state } from "ccstate";
import {
  paidToolsContract,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import {
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
  userModelPreferenceContract,
} from "@okouai/api-contracts/contracts/user-model-preference";
import {
  click,
  holdElementAnimations,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const DATA_ROUTER_URLS = Object.freeze([
  "https://data.okou.ai/mcp",
  "https://okou-data-router-staging.vm0.workers.dev/mcp",
]);

function mockPaidTools(initialDisabledTools: PaidToolId[] = []) {
  const disabledTools$ = state(initialDisabledTools);
  const updates: { toolId: string; disabled: boolean }[] = [];
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: context.store.get(disabledTools$) });
  });
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    updates.push({ toolId: params.toolId, disabled: body.disabled });
    context.store.set(disabledTools$, (previous) => {
      const enabled = previous.filter((toolId) => {
        return toolId !== params.toolId;
      });
      return body.disabled ? [...enabled, params.toolId] : enabled;
    });
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
  return updates;
}

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

async function openPaidTools(
  path = "/?settings=tools",
  locale: "en-US" | "zh-Hans" = "en-US",
) {
  context.mocks.data.org({
    id: "org_default",
    name: "Research team",
    role: "member",
  });
  await setupPage({
    context,
    path,
    locale,
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: "org_default", name: "Research team" },
        memberships: [{ id: "org_default" }],
      },
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

test("Members manage Paid tools in Tools", async () => {
  const dialog = await openPaidTools("/?settings=preference");
  click(button("Tools", dialog));
  const toggle = await readySwitch("Web search");
  expect(toggle).toBeChecked();
  await expect(
    within(dialog).findByRole("switch", { name: "Financial data" }),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "These settings apply only to you in Research team.",
    ),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(/Tasks already running or prepared/),
  ).toBeInTheDocument();
  expect(window.location.search).toContain("settings=tools");
});

test("Paid tools toggles save inverted enabled state and can re-enable a tool", async () => {
  const updates = mockPaidTools(["web-search"]);
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

test("Advanced data research saves independently and retains preferences across Tools visits", async () => {
  const updates = mockPaidTools();
  const dialog = await openPaidTools();
  const advanced = await readySwitch("Advanced data research");
  const people = await readySwitch("People search");
  expect(advanced).toBeChecked();
  expect(people).toBeChecked();
  click(advanced);
  await waitFor(() => {
    expect(updates).toStrictEqual([{ toolId: "data-search", disabled: true }]);
  });
  click(button("Preference", dialog));
  await within(dialog).findByRole("heading", { name: "Preference" });
  click(button("Tools", dialog));
  const savedAdvanced = await readySwitch("Advanced data research");
  expect(savedAdvanced).toHaveAttribute("aria-checked", "false");
  await expect(readySwitch("People search")).resolves.toBeChecked();
  click(savedAdvanced);
  await waitFor(() => {
    expect(savedAdvanced).toBeChecked();
  });
  await expect(readySwitch("People search")).resolves.toBeChecked();
  expect(updates).toStrictEqual([
    { toolId: "data-search", disabled: true },
    { toolId: "data-search", disabled: false },
  ]);
});

function mockDataRouter(result: unknown, status = 200) {
  for (const url of DATA_ROUTER_URLS) {
    context.mocks.http.post(url, async ({ request }) => {
      expect(request.headers.get("authorization")).toBeNull();
      const message = (await request.json()) as { id: unknown };
      return status === 200
        ? HttpResponse.json({ jsonrpc: "2.0", id: message.id, result })
        : HttpResponse.json({ error: "Unavailable" }, { status });
    });
  }
}

test("Router families appear with Router text and toggle by their own IDs", async () => {
  const updates = mockPaidTools();
  mockDataRouter({
    tools: [
      {
        name: "web_search",
        inputSchema: { type: "object" },
        _meta: { "ai.okou/data": { family: "web-search" } },
      },
      {
        name: "future_tool",
        inputSchema: { type: "object" },
        _meta: { "ai.okou/data": { family: "future-family" } },
      },
    ],
    _meta: {
      "ai.okou/data": {
        families: [
          {
            id: "web-search",
            title: { "en-US": "Router web search" },
            description: { "en-US": "Router search copy" },
          },
          {
            id: "future-family",
            title: { "en-US": "Future research", "zh-Hans": "未来研究" },
            description: { "en-US": "Researches new sources." },
          },
          {
            id: "empty-family",
            title: { "en-US": "Empty research" },
            description: { "en-US": "No listed tools." },
          },
        ],
      },
    },
  });
  const dialog = await openPaidTools("/?settings=tools", "zh-Hans");
  const future = await readySwitch("未来研究");
  expect(
    within(dialog).getByText("Researches new sources."),
  ).toBeInTheDocument();
  expect(
    within(dialog).getAllByRole("switch", { name: "Web search" }),
  ).toHaveLength(1);
  expect(
    within(dialog).queryByRole("switch", { name: "Router web search" }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole("switch", { name: "Empty research" }),
  ).not.toBeInTheDocument();
  expect(future).toBeChecked();
  click(future);
  await waitFor(() => {
    return expect(future).not.toBeChecked();
  });
  expect(updates).toStrictEqual([{ toolId: "future-family", disabled: true }]);
});

test.each([
  ["close Settings", "first page"],
  ["close Settings", "next page"],
  ["navigate back", "first page"],
  ["navigate back", "next page"],
] as const)(
  "Router discovery is cancelled when you %s during its delayed %s and loads on a new visit",
  async (action, delayedPage) => {
    mockPaidTools(["future-family"]);
    const requested = context.mocks.deferred<void>();
    const releaseResponse = context.mocks.deferred<void>();
    const cancelled = context.mocks.deferred<void>();
    let catalog = "Abandoned research";
    let holdNextResponse = true;
    for (const url of DATA_ROUTER_URLS) {
      context.mocks.http.post(url, async ({ request }) => {
        const message = (await request.json()) as {
          id: unknown;
          params?: { cursor?: string };
        };
        const cursor = message.params?.cursor;
        const title = cursor ?? catalog;
        const result = cursor
          ? {
              tools: [
                {
                  name: "future_tool",
                  inputSchema: { type: "object" },
                  _meta: { "ai.okou/data": { family: "future-family" } },
                },
              ],
              _meta: {
                "ai.okou/data": {
                  families: [
                    {
                      id: "future-family",
                      title: { "en-US": title },
                      description: { "en-US": "Researches new sources." },
                    },
                  ],
                },
              },
            }
          : {
              tools: [],
              nextCursor: title,
              _meta: {
                "ai.okou/data": {
                  families: [
                    {
                      id: "future-family",
                      title: { "en-US": title },
                      description: { "en-US": "Researches new sources." },
                    },
                  ],
                },
              },
            };
        if (
          holdNextResponse &&
          (delayedPage === "first page" ? !cursor : Boolean(cursor))
        ) {
          holdNextResponse = false;
          // The external HTTP peer releases its delayed response only when
          // the caller cancels it. No application signal or store is inspected.
          request.signal.addEventListener(
            "abort",
            () => {
              releaseResponse.resolve();
            },
            { once: true },
          );
          requested.resolve();
          await releaseResponse.promise;
          cancelled.resolve();
        }
        return HttpResponse.json({ jsonrpc: "2.0", id: message.id, result });
      });
    }

    const dialog = await openPaidTools("/?settings=preference");
    await within(dialog).findByRole("heading", { name: "Preference" });
    click(button("Tools", dialog));
    await readySwitch("Web search");
    await within(dialog).findByText("Loading your tool settings…");
    await requested.promise;
    catalog = "Reopened research";

    let reopened: HTMLElement;
    let settingsAfterInterruption: string | null;
    if (action === "close Settings") {
      const finishClose = holdElementAnimations(dialog);
      click(within(dialog).getByLabelText("Close"));
      // Dismissal must cancel discovery before the exit animation completes.
      await cancelled.promise;
      settingsAfterInterruption = new URLSearchParams(
        window.location.search,
      ).get("settings");
      const closed = waitForElementToBeRemoved(dialog);
      finishClose();
      await closed;
      const rail = await screen.findByTestId("labeled-nav-rail");
      click(within(rail).getByLabelText("Test User"));
      const menu = await screen.findByRole("menu");
      click(within(menu).getByText("Settings", { exact: true }));
      reopened = await screen.findByRole("dialog", { name: "Settings" });
    } else {
      act(() => {
        window.history.back();
      });
      await cancelled.promise;
      reopened = await screen.findByRole("dialog", { name: "Settings" });
      settingsAfterInterruption = new URLSearchParams(
        window.location.search,
      ).get("settings");
    }
    expect(settingsAfterInterruption).toBe(
      action === "close Settings" ? null : "preference",
    );
    await within(reopened).findByRole("heading", { name: "Preference" });
    click(button("Tools", reopened));
    const future = await readySwitch("Reopened research");
    expect(future).not.toBeChecked();
    expect(
      within(reopened).queryByRole("switch", { name: "Abandoned research" }),
    ).not.toBeInTheDocument();
    click(future);
    await waitFor(() => {
      expect(future).toBeChecked();
    });
    await expect(readySwitch("Web search")).resolves.toBeChecked();
  },
);

test("A failed Router catalog is reported while Okou tools stay manageable", async () => {
  const updates = mockPaidTools();
  mockDataRouter(null, 503);
  const dialog = await openPaidTools();
  await within(dialog).findByText("Your tool settings could not be loaded.");
  expect(
    within(dialog).queryByRole("switch", { name: "Financial data" }),
  ).not.toBeInTheDocument();
  const webSearch = await readySwitch("Web search");
  click(webSearch);
  await waitFor(() => {
    return expect(webSearch).not.toBeChecked();
  });
  await expect(readySwitch("Image generation")).resolves.toBeChecked();
  expect(updates).toStrictEqual([{ toolId: "web-search", disabled: true }]);
});

test("A failed load shows no assumed enabled tools", async () => {
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(500, {
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
  mockPaidTools(["image-generation"]);
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
    context.mocks.ably.trigger("userPreferenceChanged", {
      kinds: ["defaultImageModel"],
    });
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

test("A failed image model save retains the unsaved choice", async () => {
  const updates: UpdateUserModelPreferenceRequest[] = [];
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    updates.push(body);
    return respond(500, {
      error: {
        message: "Preferences temporarily unavailable",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
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
  expect(select).toHaveTextContent("Nano Banana 2 Lite");
});

test.each(["disable image generation", "leave Tools"] as const)(
  "An unsaved image model is discarded when you %s",
  async (action) => {
    context.mocks.api(userModelPreferenceContract.update, ({ respond }) => {
      return respond(500, {
        error: {
          message: "Preferences temporarily unavailable",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    });
    mockPaidTools();
    const dialog = await openPaidTools();
    const select = await imageModelSelect();
    await waitFor(() => {
      expect(select).not.toBeDisabled();
    });
    const user = userEvent.setup();
    await user.click(select);
    await user.click(
      await screen.findByRole("option", { name: /^Ideogram 4/ }),
    );
    await within(dialog).findByText("Your image model was not saved.");
    expect(select).toHaveTextContent("Ideogram 4");
    if (action === "disable image generation") {
      click(await readySwitch("Image generation"));
    } else {
      click(button("Preference", dialog));
      await within(dialog).findByRole("heading", { name: "Preference" });
      click(button("Tools", dialog));
    }
    const storedSelect = await imageModelSelect();
    await waitFor(() => {
      expect(storedSelect).toHaveTextContent("GPT Image 2.5 Flare");
    });
    expect(storedSelect).toHaveProperty(
      "disabled",
      action === "disable image generation",
    );
    expect(
      within(dialog).queryByText("Your image model was not saved."),
    ).not.toBeInTheDocument();
  },
);

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

test.each(["preference read", "write token"] as const)(
  "An image model save cannot cross workspaces while awaiting its %s",
  async (boundary) => {
    const waiting = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const updates: UpdateUserModelPreferenceRequest[] = [];
    let holdSave = false;
    let preference = modelPreference();
    context.mocks.api(userModelPreferenceContract.get, async ({ respond }) => {
      const requestedPreference = preference;
      if (holdSave) {
        holdSave = false;
        if (boundary === "preference read") {
          waiting.resolve();
          await release.promise;
        } else {
          mockedClerk.sessionGetToken.mockImplementationOnce(async () => {
            waiting.resolve();
            await release.promise;
            return "new-workspace-token";
          });
        }
      }
      return respond(200, requestedPreference);
    });
    context.mocks.api(
      userModelPreferenceContract.update,
      ({ body, respond }) => {
        updates.push(body);
        preference = modelPreference({
          selectedModel: body.selectedModel,
          serviceTier: body.serviceTier,
          selectedImageModel: body.selectedImageModel ?? null,
        });
        return respond(200, preference);
      },
    );
    await openPaidTools();
    const select = await imageModelSelect();
    await waitFor(() => {
      expect(select).not.toBeDisabled();
    });
    holdSave = true;
    const user = userEvent.setup();
    await user.click(select);
    await user.click(
      await screen.findByRole("option", { name: /^Ideogram 4/ }),
    );
    await waiting.promise;
    await act(() => {
      preference = modelPreference({ selectedImageModel: "fal-ai/flux-2-pro" });
      context.mocks.clerk().organization({
        activeOrg: { id: "org_second", name: "Second workspace" },
        memberships: [{ id: "org_second" }],
      });
      context.mocks.clerk().stateChanged();
      release.resolve();
      return release.promise;
    });
    await screen.findByText(
      "These settings apply only to you in Second workspace.",
    );
    const nextSelect = await imageModelSelect();
    await waitFor(() => {
      expect(nextSelect).not.toBeDisabled();
    });
    expect(updates).toStrictEqual([]);
  },
);
