import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import {
  userModelPreferenceContract,
  type UpdateUserModelPreferenceRequest,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function defaultPreferences(): UserPreferencesResponse {
  return {
    timezone: "Etc/UTC",
    locale: "en-US",
    supportedLocales: ["en-US", "pt-BR"],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: true,
    theme: "system",
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
}

function mockPreferences(
  overrides: Partial<UserPreferencesResponse> = {},
): UpdateUserPreferencesRequest[] {
  let preferences: UserPreferencesResponse = {
    ...defaultPreferences(),
    ...overrides,
  };
  const updates: UpdateUserPreferencesRequest[] = [];
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences);
  });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      cloudBrowserAvailable: true,
      sshHosts: [],
      vncHosts: [],
      computerUseHosts: [],
      cloudBrowserEnabledByDefault: preferences.cloudBrowserEnabledByDefault,
    });
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    const update = { ...body };
    updates.push(update);
    preferences = { ...preferences, ...update };
    return respond(200, preferences);
  });
  return updates;
}

function getFastRole(
  role: Parameters<typeof queryAllByRoleFast>[0],
  name: string | RegExp,
  container: ParentNode = document.body,
): HTMLElement {
  const element = queryAllByRoleFast(role, container).find((candidate) => {
    const accessibleName =
      candidate.getAttribute("aria-label") ??
      candidate.textContent?.replace(/\s+/gu, " ").trim() ??
      "";
    return typeof name === "string"
      ? accessibleName === name
      : name.test(accessibleName);
  });
  if (!element) {
    throw new Error(`${role} not found: ${name}`);
  }
  return element;
}

function expectSelected(element: HTMLElement): void {
  const selectionAttribute =
    element.getAttribute("aria-checked") ??
    element.getAttribute("aria-pressed");
  expect(selectionAttribute).toBe("true");
}

test("A missing workspace theme follows the system and explicit choices are saved", async () => {
  const updates = mockPreferences({ theme: null });
  const cookieWrites: string[] = [];
  vi.spyOn(document, "cookie", "set").mockImplementation((value) => {
    cookieWrites.push(value);
  });
  context.mocks.browser.cookie("__Secure-okou-theme=v1.dark");

  await setupPage({ context, path: "/settings", host: "app.vm7.ai" });

  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expectSelected(getFastRole("button", "System"));
  });
  expect(
    updates.filter((update) => {
      return update.theme !== undefined;
    }),
  ).toStrictEqual([]);
  click(getFastRole("button", "Light"));

  await waitFor(() => {
    expectSelected(getFastRole("button", "Light"));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(getFastRole("button", "Light")).toBeEnabled();
    expect(updates).toContainEqual({ theme: "light" });
  });
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=v1.light; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );

  click(getFastRole("button", "System"));
  await waitFor(() => {
    expectSelected(getFastRole("button", "System"));
    expect(getFastRole("button", "System")).toBeEnabled();
    expect(updates).toContainEqual({ theme: "system" });
  });
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=v1.system; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );
});

test("A saved workspace mode overrides the cookie and saves independently of the palette", async () => {
  const updates = mockPreferences({
    theme: "dark",
    colorTheme: "golden-hour",
  });
  const cookieWrites: string[] = [];
  vi.spyOn(document, "cookie", "set").mockImplementation((value) => {
    cookieWrites.push(value);
  });
  context.mocks.browser.cookie(
    "__Secure-okou-theme=v1.light; __Secure-okou-color-theme=cotton-sky",
  );

  await setupPage({
    context,
    path: "/settings",
    host: "app.okou.ai",
  });

  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  const colorTheme = await screen.findByRole("group", { name: "Color theme" });
  await waitFor(() => {
    expectSelected(getFastRole("button", "Dark"));
  });
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expectSelected(getFastRole("button", "Golden hour", colorTheme));
  expect(cookieWrites).toContain(
    "__Secure-okou-color-theme=golden-hour; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );

  // Another page on the shared domain can change the first-paint cookie.
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expectSelected(getFastRole("button", "Dark"));
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");

  click(getFastRole("button", "Light"));

  await waitFor(() => {
    expectSelected(getFastRole("button", "Light"));
    expect(getFastRole("button", "Light")).toBeEnabled();
    expect(updates).toContainEqual({ theme: "light" });
  });

  const selectedAppearance = ["Light", "Dark", "System"].find((name) => {
    return getFastRole("button", name).getAttribute("aria-pressed") === "true";
  });
  if (!selectedAppearance) {
    throw new Error("Expected a selected appearance option");
  }
  const resolvedTheme = document.documentElement.dataset.theme;
  click(getFastRole("button", selectedAppearance));
  expectSelected(getFastRole("button", selectedAppearance));
  expect(document.documentElement).toHaveAttribute("data-theme", resolvedTheme);

  click(getFastRole("button", "Deep lagoon", colorTheme));

  const deepLagoon = getFastRole("button", "Deep lagoon", colorTheme);
  await waitFor(() => {
    expect(deepLagoon).toBeEnabled();
    expect(updates).toContainEqual({ colorTheme: "deep-lagoon" });
  });
  expectSelected(deepLagoon);
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  expect(document.documentElement).toHaveAttribute(
    "data-color-theme",
    "deep-lagoon",
  );
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=v1.light; Domain=.okou.ai; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );
  expect(cookieWrites).toContain(
    "__Secure-okou-color-theme=deep-lagoon; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );
});

test("Appearance choices made during startup survive the initial workspace read", async () => {
  mockPreferences({ theme: "light" });
  context.mocks.browser.cookie("__Secure-okou-theme=v1.light");
  const releaseInitialRead = context.mocks.deferred<void>();
  const releaseSave = context.mocks.deferred<void>();
  context.mocks.api(
    userPreferencesContract.get,
    async ({ respond, withSignal }) => {
      await withSignal(releaseInitialRead.promise);
      return respond(200, {
        ...defaultPreferences(),
        theme: "light",
        colorTheme: "golden-hour",
      });
    },
  );
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond, withSignal }) => {
      await withSignal(releaseSave.promise);
      return respond(200, { ...defaultPreferences(), ...body });
    },
  );

  const page = await startPage({
    context,
    path: "/?settings=preference",
    host: "app.okou.ai",
  });
  await page.content;
  const palette = await screen.findByRole("group", { name: "Color theme" });
  const dark = getFastRole("button", "Dark");
  const deepLagoon = getFastRole("button", "Deep lagoon", palette);
  click(dark);
  click(deepLagoon);
  expectSelected(dark);
  expect(dark).toBeDisabled();
  expectSelected(deepLagoon);
  expect(deepLagoon).toBeDisabled();

  releaseInitialRead.resolve();
  await page.ready;
  expectSelected(dark);
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expectSelected(deepLagoon);
  expect(document.documentElement).toHaveAttribute(
    "data-color-theme",
    "deep-lagoon",
  );

  releaseSave.resolve();
  await waitFor(() => {
    expect(dark).toBeEnabled();
    expect(deepLagoon).toBeEnabled();
  });
});

test("A failed theme save keeps the local choice and can be retried", async () => {
  mockPreferences();
  const cookieWrites: string[] = [];
  vi.spyOn(document, "cookie", "set").mockImplementation((value) => {
    cookieWrites.push(value);
  });
  context.mocks.browser.cookie("__Secure-okou-theme=v1.light");
  const releaseFailure = context.mocks.deferred<void>();
  let unavailable = true;
  let savedUpdate: UpdateUserPreferencesRequest | undefined;
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond, withSignal }) => {
      if (unavailable) {
        await withSignal(releaseFailure.promise);
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Theme preference could not be saved",
          },
        });
      }
      savedUpdate = body;
      return respond(200, { ...defaultPreferences(), ...body });
    },
  );

  await setupPage({ context, path: "/settings", host: "app.okou.ai" });
  await screen.findByText("Your preferred color scheme");
  const dark = getFastRole("button", "Dark");
  click(dark);

  await waitFor(() => {
    expectSelected(dark);
    expect(dark).toBeDisabled();
    expect(getFastRole("button", "Light")).toBeDisabled();
    expect(getFastRole("button", "System")).toBeDisabled();
  });
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");

  releaseFailure.resolve();
  await expect(
    screen.findByText("Theme preference could not be saved"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(dark).toBeEnabled();
  });
  expectSelected(dark);
  expect(cookieWrites.join("\n")).not.toContain("__Secure-okou-theme=v1.dark");

  unavailable = false;
  click(dark);
  await waitFor(() => {
    expect(savedUpdate).toStrictEqual({ theme: "dark" });
    expect(dark).toBeEnabled();
  });
  expectSelected(dark);
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=v1.dark; Domain=.okou.ai; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );
});

test("A cached palette is visible during startup and cleared when the workspace uses the default", async () => {
  const updates = mockPreferences({ colorTheme: null });
  const cookieWrites: string[] = [];
  vi.spyOn(document, "cookie", "set").mockImplementation((value) => {
    cookieWrites.push(value);
  });
  context.mocks.browser.cookie("__Secure-okou-color-theme=citrus-spark");
  const releaseInitialRead = context.mocks.deferred<void>();
  let preferencesReads = 0;
  context.mocks.api(
    userPreferencesContract.get,
    async ({ respond, withSignal }) => {
      preferencesReads += 1;
      await withSignal(releaseInitialRead.promise);
      return respond(200, { ...defaultPreferences(), colorTheme: null });
    },
  );

  const page = await startPage({
    context,
    path: "/?settings=preference",
    host: "app.okou.ai",
  });
  await page.content;
  const colorTheme = await screen.findByRole("group", { name: "Color theme" });
  expectSelected(getFastRole("button", "Citrus spark", colorTheme));
  expect(document.documentElement).toHaveAttribute(
    "data-color-theme",
    "citrus-spark",
  );

  releaseInitialRead.resolve();
  await page.ready;
  expect(preferencesReads).toBe(1);
  expectSelected(getFastRole("button", "Default", colorTheme));
  expect(document.documentElement).not.toHaveAttribute("data-color-theme");
  expect(document.documentElement).not.toHaveAttribute(
    "data-gradient-color-themes",
  );
  expect(cookieWrites).toContain(
    "__Secure-okou-color-theme=; Path=/; Max-Age=0; SameSite=Lax; Secure",
  );

  // An absent palette stays absent until the member picks one, so the first
  // palette this workspace records is the one they click.
  click(getFastRole("button", "Golden hour", colorTheme));

  await waitFor(() => {
    expectSelected(getFastRole("button", "Golden hour", colorTheme));
  });
  expect(
    updates.filter((update) => {
      return update.colorTheme !== undefined;
    }),
  ).toStrictEqual([{ colorTheme: "golden-hour" }]);
});

test("Chat settings select models without changing the current model's options", async () => {
  const user = userEvent.setup({ delay: null });
  context.mocks.data.personalModelProviders([
    {
      id: "00000000-0000-4000-a000-000000000601",
      type: "codex-oauth-token",
      framework: "codex",
      needsReconnect: false,
      lastRefreshErrorCode: null,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
  ]);
  const updates = mockPreferences({ cloudBrowserEnabledByDefault: false });
  context.mocks.data.userModelPreference({
    selectedModel: "gpt-6-astra",
    serviceTier: "priority",
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: "2026-09-06T00:00:00.000Z",
  });
  const modelUpdates: UpdateUserModelPreferenceRequest[] = [];
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    modelUpdates.push(body);
    const preference = {
      selectedModel: body.selectedModel,
      serviceTier: body.serviceTier,
      modelSettings:
        body.modelSettingsPatch === undefined
          ? {}
          : {
              [body.modelSettingsPatch.model]: {
                effort: body.modelSettingsPatch.effort,
              },
            },
      selectedImageModel: null,
      updatedAt: "2026-09-06T00:00:01.000Z",
    };
    context.mocks.data.userModelPreference(preference);
    return respond(200, preference);
  });

  await setupPage({
    context,
    path: "/?settings=chat",
    host: "app.okou.ai",
  });

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(within(dialog).getByRole("heading", { name: "Chat" })).toBeVisible();
  expect(
    within(dialog).getByText(
      "Choose defaults for new chats and how messages are sent.",
    ),
  ).toBeVisible();
  const defaultModel = within(dialog).getByText("Default model");
  const cloudBrowserTitle = within(dialog).getByText("Cloud browser");
  const sendMode = within(dialog).getByText("Send message with");
  expect(
    defaultModel.compareDocumentPosition(cloudBrowserTitle) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    cloudBrowserTitle.compareDocumentPosition(sendMode) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  const picker = await within(dialog).findByRole("combobox", {
    name: "GPT 6 Astra",
  });
  await user.click(picker);
  const selectedOption = await screen.findByRole("option", {
    name: "GPT 6 Astra",
    selected: true,
  });
  await waitFor(() => {
    expect(selectedOption).toHaveFocus();
  });
  expect(
    screen.getAllByRole("option", { name: /^GPT 6 Astra/u }),
  ).toStrictEqual([selectedOption]);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(picker).toHaveFocus();
  });
  await user.click(picker);
  click(await screen.findByRole("option", { name: "GPT 6 Astra" }));
  await waitFor(() => {
    expect(modelUpdates).toContainEqual({
      selectedModel: "gpt-6-astra",
      serviceTier: "priority",
    });
    expect(
      within(dialog).getByRole("combobox", { name: "GPT 6 Astra" }),
    ).toBeVisible();
  });
  click(within(dialog).getByRole("combobox", { name: "GPT 6 Astra" }));
  click(await screen.findByRole("option", { name: "Auto" }));
  await waitFor(() => {
    expect(modelUpdates).toContainEqual({
      selectedModel: null,
      serviceTier: null,
    });
    expect(
      within(dialog).getByRole("combobox", {
        name: "Auto",
      }),
    ).toBeVisible();
  });

  const cloudBrowser = within(dialog).getByRole("switch", {
    name: "Cloud browser",
  });
  expect(cloudBrowser).not.toBeChecked();

  click(cloudBrowser);

  await waitFor(() => {
    expect(updates).toContainEqual({ cloudBrowserEnabledByDefault: true });
    expect(
      within(dialog).getByRole("switch", { name: "Cloud browser" }),
    ).toBeChecked();
  });

  click(getFastRole("button", "⌘ Enter", dialog));
  await waitFor(() => {
    expect(updates).toContainEqual({ sendMode: "cmd-enter" });
  });
});

test("A user can save a message-send preference in Chat settings", async () => {
  const updates = mockPreferences();

  await setupPage({
    context,
    path: "/?settings=chat",
    host: "app.okou.ai",
  });

  await expect(screen.findByText("Send message with")).resolves.toBeVisible();
  click(getFastRole("button", "⌘ Enter"));

  await waitFor(() => {
    expect(updates).toContainEqual({ sendMode: "cmd-enter" });
    expect(getFastRole("button", "⌘ Enter")).toBeEnabled();
    expectSelected(getFastRole("button", "⌘ Enter"));
  });

  click(getFastRole("button", "⌘ Enter"));
  expectSelected(getFastRole("button", "⌘ Enter"));
  expect(getFastRole("button", "Enter")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("Saving a time zone refreshes the recovered Morning Brief preference", async () => {
  const updates = mockPreferences();
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return updates.some((update) => {
      return update.timezone === "America/New_York";
    })
      ? respond(200, {
          enabled: true,
          status: "enabled",
          unavailableReason: null,
        })
      : respond(409, {
          error: {
            code: "MORNING_BRIEF_STATE_CONFLICT",
            message: "Missing time zone",
          },
        });
  });

  await setupPage({
    context,
    path: "/settings",
    host: "app.okou.ai",
  });

  const timezone = await screen.findByRole("combobox", { name: "Time zone" });
  await screen.findByText(/Morning Brief is temporarily unavailable/u);
  expect(timezone).toHaveTextContent("UTC");
  timezone.focus();
  expect(timezone).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("option", {
    name: /Eastern Time \(ET\)$/u,
  });
  await userEvent.keyboard("{Home}{ArrowDown}{Enter}");

  await waitFor(() => {
    expect(timezone).toHaveTextContent("Eastern Time (ET)");
    expect(timezone).toBeEnabled();
  });
  expect(timezone).toHaveAccessibleName("Time zone");
  expect(updates).toContainEqual({ timezone: "America/New_York" });
  await waitFor(() => {
    expect(screen.getByRole("switch", { name: "Morning brief" })).toBeChecked();
    expect(
      screen.queryByText(/Morning Brief is temporarily unavailable/u),
    ).not.toBeInTheDocument();
  });
});

test("A failed preference save shows its error and can be retried", async () => {
  let preferences = defaultPreferences();
  let unavailable = true;
  const releaseFailure = context.mocks.deferred<void>();
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences);
  });
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond, withSignal }) => {
      if (unavailable) {
        await withSignal(releaseFailure.promise);
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Preferences could not be saved",
          },
        });
      }
      preferences = { ...preferences, ...body };
      return respond(200, preferences);
    },
  );
  await setupPage({
    context,
    path: "/?settings=chat",
  });

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const sendMode = getFastRole("button", "⌘ Enter", dialog);
  click(sendMode);
  await waitFor(() => {
    expect(sendMode).toBeDisabled();
  });
  releaseFailure.resolve();
  await expect(
    screen.findByText("Preferences could not be saved"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(sendMode).toBeEnabled();
    expectSelected(getFastRole("button", "Enter", dialog));
  });

  unavailable = false;
  click(sendMode);
  await waitFor(() => {
    expectSelected(sendMode);
    expect(sendMode).toBeEnabled();
  });
});

test("First paint cleans up duplicate cookies before the shared workspace mode loads", async () => {
  mockPreferences({ theme: "dark" });
  let cookie = "__Secure-okou-theme=v1.dark; __Secure-okou-theme=v1.light";
  const cookieWrites: string[] = [];
  vi.spyOn(document, "cookie", "get").mockImplementation(() => {
    return cookie;
  });
  vi.spyOn(document, "cookie", "set").mockImplementation((value) => {
    cookieWrites.push(value);
    if (
      value === "__Secure-okou-theme=; Path=/; Max-Age=0; SameSite=Lax; Secure"
    ) {
      cookie = "__Secure-okou-theme=v1.light";
    }
  });

  await setupPage({ context, path: "/settings", host: "app.vm0.ai" });

  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expectSelected(getFastRole("button", "Dark"));
  });
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=; Path=/; Max-Age=0; SameSite=Lax; Secure",
  );
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=v1.light; Domain=.vm0.ai; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=v1.dark; Domain=.vm0.ai; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );
});
