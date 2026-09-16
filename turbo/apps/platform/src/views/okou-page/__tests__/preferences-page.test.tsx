import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

const context = testContext();

test("Debug preferences restore and change the voice input model", async () => {
  const updates = mockPreferences({
    voiceInputModel: "google/gemini-3.6-flash",
  });
  await setupPage({
    context,
    path: "/?settings=debug",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  const picker = await screen.findByLabelText("Voice input model");
  await waitFor(() => {
    return expect(picker).toHaveTextContent("Gemini 3.6 Flash");
  });
  click(picker);
  const option = await waitFor(() => {
    const element = getFastRole("option", "ElevenLabs Scribe v2");
    expect(element).toBeVisible();
    return element;
  });
  click(option);
  await waitFor(() => {
    return expect(picker).toHaveTextContent("ElevenLabs Scribe v2");
  });
  expect(updates).toContainEqual({
    voiceInputModel: "fal-ai/elevenlabs/speech-to-text/scribe-v2",
  });
});

test("Debug preferences reset a saved voice input model to the default", async () => {
  const updates = mockPreferences({
    voiceInputModel: "fal-ai/elevenlabs/speech-to-text/scribe-v2",
  });
  await setupPage({
    context,
    path: "/?settings=debug",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  const picker = await screen.findByLabelText("Voice input model");
  await waitFor(() => {
    expect(picker).toHaveTextContent("ElevenLabs Scribe v2");
  });
  click(picker);
  const option = await waitFor(() => {
    const element = getFastRole("option", "Default (Gemini 3.1 Flash-Lite)");
    expect(element).toBeVisible();
    return element;
  });
  click(option);
  await waitFor(() => {
    return expect(picker).toHaveTextContent("Default (Gemini 3.1 Flash-Lite)");
  });
  expect(updates).toContainEqual({ voiceInputModel: null });
});

test("Voice model selection is hidden while Debug is disabled", async () => {
  mockPreferences({ voiceInputModel: "google/gemini-3.8-flash" });
  await setupPage({
    context,
    path: "/?settings=preference",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: false },
  });
  await screen.findByRole("dialog");
  expect(
    screen.queryByRole("combobox", { name: "Voice input model" }),
  ).not.toBeInTheDocument();
});

function defaultPreferences(): UserPreferencesResponse {
  return {
    timezone: "Etc/UTC",
    locale: "en-US",
    translationLanguage: null,
    supportedLocales: ["en-US", "pt-BR"],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
    voiceInputModel: null,
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

function mockUnavailableTokenRefresh(): void {
  mockedClerk.sessionGetToken.mockImplementation((options) => {
    return options?.skipCache
      ? Promise.reject(new Error("Token refresh is unavailable"))
      : Promise.resolve("test-token");
  });
}

test("Chat preferences save when Clerk token refresh is unavailable", async () => {
  mockPreferences({ cloudBrowserEnabledByDefault: false });
  mockUnavailableTokenRefresh();
  await setupPage({
    context,
    path: "/agents?settings=chat",
    featureSwitches: { [FeatureSwitchKey.ChatPreference]: true },
  });

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const cloudBrowser = within(dialog).getByRole("switch", {
    name: "Cloud browser",
  });
  expect(cloudBrowser).not.toBeChecked();
  click(cloudBrowser);
  await waitFor(() => {
    expect(cloudBrowser).toBeChecked();
    expect(cloudBrowser).not.toHaveAttribute("aria-disabled", "true");
  });

  click(getFastRole("button", "⌘ Enter", dialog));
  await waitFor(() => {
    expectSelected(getFastRole("button", "⌘ Enter", dialog));
    expect(getFastRole("button", "⌘ Enter", dialog)).toBeEnabled();
  });
});

test("Timezone saves refresh Morning Brief when Clerk token refresh is unavailable", async () => {
  let preferences = defaultPreferences();
  const nextRunAt = "2030-01-02T14:00:00.000Z";
  mockUnavailableTokenRefresh();
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences);
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    preferences = { ...preferences, ...body };
    return respond(200, preferences);
  });
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return respond(200, {
      enabled: true,
      status: "enabled",
      nextRunAt,
      timezone: preferences.timezone,
      unavailableReason: null,
    });
  });
  await setupPage({
    context,
    path: "/agents?settings=preference",
    featureSwitches: { [FeatureSwitchKey.MorningBrief]: true },
  });

  const card = await screen.findByTestId("morning-brief-preference");
  await expect(
    within(card).findByText(/Next brief .*\(Etc\/UTC\)/u),
  ).resolves.toBeInTheDocument();
  const timezone = getFastRole("combobox", /UTC/u);
  click(timezone);
  click(await screen.findByRole("option", { name: /Eastern Time \(ET\)$/u }));

  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(nextRunAt));
  await expect(
    within(card).findByText(`Next brief ${formatted} (America/New_York)`),
  ).resolves.toBeInTheDocument();
  expect(timezone).toHaveTextContent("Eastern Time (ET)");
  expect(timezone).toBeEnabled();
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
  await setupPage({ context, path: "/agents?settings=preference" });

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

test("Navigating away cancels a pending preference save", async () => {
  let preferences = defaultPreferences();
  let holdUpdate = true;
  const requested = context.mocks.deferred<AbortSignal>();
  const releaseUpdate = context.mocks.deferred<void>();
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences);
  });
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, request, respond, withSignal }) => {
      if (holdUpdate) {
        requested.resolve(request.signal);
        await withSignal(releaseUpdate.promise);
      }
      preferences = { ...preferences, ...body };
      return respond(200, preferences);
    },
  );
  await setupPage({ context, path: "/agents?settings=preference" });

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  click(getFastRole("button", "⌘ Enter", dialog));
  const requestSignal = await requested.promise;
  expect(getFastRole("button", "⌘ Enter", dialog)).toBeDisabled();
  click(getFastRole("button", "Close", dialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
  click(getFastRole("link", "Workflows"));
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(requestSignal.aborted).toBeTruthy();
  });
  releaseUpdate.resolve();
  holdUpdate = false;

  window.history.back();
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  window.history.back();
  const reopened = await screen.findByRole("dialog", { name: "Settings" });
  expectSelected(getFastRole("button", "Enter", reopened));
  click(getFastRole("button", "⌘ Enter", reopened));
  await waitFor(() => {
    expectSelected(getFastRole("button", "⌘ Enter", reopened));
    expect(getFastRole("button", "⌘ Enter", reopened)).toBeEnabled();
  });
});

test("Theme preferences initialize from the shared cookie", async () => {
  const updates = mockPreferences({ theme: null });
  const cookieWrites: string[] = [];
  vi.spyOn(document, "cookie", "set").mockImplementation((value) => {
    cookieWrites.push(value);
  });
  const localStorageReads = vi.spyOn(localStorage, "getItem");
  const localStorageWrites = vi.spyOn(localStorage, "setItem");
  context.mocks.browser.cookie("__Secure-okou-theme=v1.dark");

  await setupPage({ context, path: "/settings", host: "app.vm7.ai" });

  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  click(getFastRole("button", "Light"));

  await waitFor(() => {
    expectSelected(getFastRole("button", "Light"));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
  expect(updates).not.toContainEqual(
    expect.objectContaining({ theme: "light" }),
  );
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=v1.light; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );
  for (const key of ["theme", "colorTheme", "okou_theme", "okou_colorTheme"]) {
    expect(localStorageReads).not.toHaveBeenCalledWith(key);
    expect(localStorageWrites).not.toHaveBeenCalledWith(key, expect.anything());
  }

  await expect(
    screen.findByText("Your agents will use this time zone during runs"),
  ).resolves.toBeVisible();
  expect(getFastRole("button", "Light")).toBeVisible();
});

test("A shared theme cookie supersedes and removes an older host-only duplicate", async () => {
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
  expectSelected(getFastRole("button", "Light"));
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=; Path=/; Max-Age=0; SameSite=Lax; Secure",
  );
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=v1.light; Domain=.vm0.ai; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );
});

test("Theme preferences refresh from the cookie when the page becomes active", async () => {
  mockPreferences({ theme: "dark" });
  let cookie = "__Secure-okou-theme=v1.dark";
  vi.spyOn(document, "cookie", "get").mockImplementation(() => {
    return cookie;
  });
  vi.spyOn(document, "cookie", "set").mockImplementation(() => {});
  const visibility = context.mocks.browser.visibilityState("visible");

  await setupPage({ context, path: "/settings", host: "app.okou.ai" });
  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");

  cookie = "__Secure-okou-theme=v1.light";
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expectSelected(getFastRole("button", "Light"));
  });

  visibility.changeTo("hidden");
  cookie = "__Secure-okou-theme=v1.dark";
  visibility.changeTo("visible");
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expectSelected(getFastRole("button", "Dark"));
  });
});

test("Cookie theme and account-backed color theme are restored and saved", async () => {
  const updates = mockPreferences({
    theme: "dark",
    colorTheme: "golden-hour",
  });
  const cookieWrites: string[] = [];
  vi.spyOn(document, "cookie", "set").mockImplementation((value) => {
    cookieWrites.push(value);
  });
  context.mocks.browser.cookie("__Secure-okou-theme=v1.light");

  await setupPage({
    context,
    path: "/settings",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: true },
  });

  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  const colorTheme = await screen.findByRole("group", { name: "Color theme" });
  expectSelected(getFastRole("button", "Light"));
  expectSelected(getFastRole("button", "Golden hour", colorTheme));

  click(getFastRole("button", "Dark"));

  await waitFor(() => {
    expectSelected(getFastRole("button", "Dark"));
  });
  expect(updates).not.toContainEqual(
    expect.objectContaining({ theme: "dark" }),
  );

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

  await waitFor(() => {
    expect(updates).toContainEqual({ colorTheme: "deep-lagoon" });
    expectSelected(getFastRole("button", "Deep lagoon", colorTheme));
  });
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(document.documentElement).toHaveAttribute(
    "data-color-theme",
    "deep-lagoon",
  );
  expect(cookieWrites).toContain(
    "__Secure-okou-theme=v1.dark; Domain=.okou.ai; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );
  expect(cookieWrites.join("\n")).not.toMatch(/golden-hour|deep-lagoon/u);
});

test("A user can select a gradient color theme when available", async () => {
  const updates = mockPreferences({ colorTheme: "blue-horizon" });

  await setupPage({
    context,
    path: "/settings",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: true },
  });

  const colorTheme = await screen.findByRole("group", { name: "Color theme" });
  expectSelected(getFastRole("button", "Blue horizon", colorTheme));
  click(getFastRole("button", "Golden hour", colorTheme));

  await waitFor(() => {
    expect(updates).toContainEqual({ colorTheme: "golden-hour" });
    expectSelected(getFastRole("button", "Golden hour", colorTheme));
  });
  expect(document.documentElement).toHaveAttribute(
    "data-color-theme",
    "golden-hour",
  );
});

test("A user can return to the default palette from a gradient color theme", async () => {
  const updates = mockPreferences({ colorTheme: "blue-horizon" });

  await setupPage({
    context,
    path: "/settings",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: true },
  });

  const colorTheme = await screen.findByRole("group", { name: "Color theme" });
  expect(document.documentElement).toHaveAttribute(
    "data-color-theme",
    "blue-horizon",
  );
  click(getFastRole("button", "Default", colorTheme));

  await waitFor(() => {
    expect(updates).toContainEqual({ colorTheme: "default" });
    expectSelected(getFastRole("button", "Default", colorTheme));
  });
  expect(document.documentElement).not.toHaveAttribute("data-color-theme");
  expect(document.documentElement).not.toHaveAttribute(
    "data-gradient-color-themes",
  );
});

test("A workspace without a saved color theme starts on the default palette", async () => {
  const updates = mockPreferences({ colorTheme: null });

  await setupPage({
    context,
    path: "/settings",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: true },
  });

  const colorTheme = await screen.findByRole("group", { name: "Color theme" });
  expectSelected(getFastRole("button", "Default", colorTheme));
  await waitFor(() => {
    expect(updates).toContainEqual({ colorTheme: "default" });
  });
  expect(document.documentElement).not.toHaveAttribute("data-color-theme");
  expect(document.documentElement).not.toHaveAttribute(
    "data-gradient-color-themes",
  );
});

test("Gradient color themes stay hidden when the capability is disabled", async () => {
  mockPreferences({ colorTheme: "blue-horizon" });

  await setupPage({
    context,
    path: "/settings",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: false },
  });

  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  expect(screen.queryByRole("group", { name: "Color theme" })).toBeNull();
  expect(document.documentElement).not.toHaveAttribute(
    "data-gradient-color-themes",
  );
  expect(document.documentElement).not.toHaveAttribute("data-color-theme");
});

test("Chat settings fall back to Preference while the capability is disabled", async () => {
  mockPreferences({ cloudBrowserEnabledByDefault: false });

  await setupPage({
    context,
    path: "/?settings=chat",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ChatPreference]: false },
  });

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(
    within(dialog).getByRole("heading", { name: "Preference" }),
  ).toBeVisible();
  expect(within(dialog).queryByText("Chat")).not.toBeInTheDocument();
  expect(within(dialog).getByText("Send message with")).toBeVisible();
  expect(
    within(dialog).queryByRole("switch", { name: "Cloud browser" }),
  ).toBeNull();
  expect(within(dialog).queryByText("Default model")).toBeNull();
  expect(new URLSearchParams(window.location.search).get("settings")).toBe(
    "preference",
  );
});

test("Chat settings keep the agreed row order and save chat defaults", async () => {
  const updates = mockPreferences({ cloudBrowserEnabledByDefault: false });
  context.mocks.data.userModelPreference({
    selectedModel: "gpt-6-astra",
    serviceTier: null,
    modelSettings: {},
    selectedVideoModel: null,
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
      selectedVideoModel: null,
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
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
      [FeatureSwitchKey.CodexFastMode]: true,
    },
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

  click(await within(dialog).findByRole("combobox", { name: "GPT 6 Astra" }));
  click(await screen.findByRole("option", { name: "GPT 6 Astra Fast" }));
  await waitFor(() => {
    expect(modelUpdates).toContainEqual({
      selectedModel: "gpt-6-astra",
      serviceTier: "priority",
    });
    expect(
      within(dialog).getByRole("combobox", { name: "GPT 6 Astra Fast" }),
    ).toBeVisible();
  });
  click(within(dialog).getByRole("combobox", { name: "GPT 6 Astra Fast" }));
  click(
    await screen.findByRole("option", { name: "Inherit from org default" }),
  );
  await waitFor(() => {
    expect(modelUpdates).toContainEqual({
      selectedModel: null,
      serviceTier: null,
    });
    expect(
      within(dialog).getByRole("combobox", {
        name: "Inherit from org default",
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

test("Chat setting controls disable while their saves settle", async () => {
  let preferences = {
    ...defaultPreferences(),
    cloudBrowserEnabledByDefault: false,
  };
  const releaseCloudUpdate = context.mocks.deferred<void>();
  const releaseSendModeUpdate = context.mocks.deferred<void>();
  const updateReleases = [releaseCloudUpdate, releaseSendModeUpdate] as const;
  let updateIndex = 0;
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences);
  });
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond, withSignal }) => {
      const release = updateReleases[updateIndex];
      if (!release) {
        throw new Error("Unexpected preference update");
      }
      updateIndex += 1;
      await withSignal(release.promise);
      preferences = { ...preferences, ...body };
      return respond(200, preferences);
    },
  );

  context.mocks.data.userModelPreference({
    selectedModel: "gpt-6-astra",
    serviceTier: null,
    modelSettings: {},
    selectedVideoModel: null,
    selectedImageModel: null,
    updatedAt: "2026-09-06T00:00:00.000Z",
  });
  const releaseModelUpdate = context.mocks.deferred<void>();
  context.mocks.api(
    userModelPreferenceContract.update,
    async ({ body, respond, withSignal }) => {
      await withSignal(releaseModelUpdate.promise);
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
        selectedVideoModel: null,
        selectedImageModel: null,
        updatedAt: "2026-09-06T00:00:01.000Z",
      };
      context.mocks.data.userModelPreference(preference);
      return respond(200, preference);
    },
  );

  await setupPage({
    context,
    path: "/?settings=chat",
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
      [FeatureSwitchKey.CodexFastMode]: true,
    },
  });

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  click(await within(dialog).findByRole("combobox", { name: "GPT 6 Astra" }));
  click(await screen.findByRole("option", { name: "GPT 6 Astra Fast" }));
  await waitFor(() => {
    expect(within(dialog).getByLabelText("GPT 6 Astra")).toBeVisible();
    expect(
      within(dialog).queryByRole("combobox", { name: "GPT 6 Astra" }),
    ).toBeNull();
  });
  releaseModelUpdate.resolve();
  await waitFor(() => {
    expect(
      within(dialog).getByRole("combobox", { name: "GPT 6 Astra Fast" }),
    ).toBeEnabled();
  });

  click(within(dialog).getByRole("switch", { name: "Cloud browser" }));
  await waitFor(() => {
    const cloudBrowser = within(dialog).getByRole("switch", {
      name: "Cloud browser",
    });
    expect(cloudBrowser).toHaveAttribute("aria-disabled", "true");
  });
  releaseCloudUpdate.resolve();
  await waitFor(() => {
    const cloudBrowser = within(dialog).getByRole("switch", {
      name: "Cloud browser",
    });
    expect(cloudBrowser).toBeChecked();
    expect(cloudBrowser).not.toHaveAttribute("aria-disabled", "true");
  });

  click(getFastRole("button", "⌘ Enter", dialog));
  await waitFor(() => {
    expect(getFastRole("button", "Enter", dialog)).toBeDisabled();
    expect(getFastRole("button", "⌘ Enter", dialog)).toBeDisabled();
  });
  releaseSendModeUpdate.resolve();
  await waitFor(() => {
    expectSelected(getFastRole("button", "⌘ Enter", dialog));
    expect(getFastRole("button", "Enter", dialog)).toBeEnabled();
    expect(getFastRole("button", "⌘ Enter", dialog)).toBeEnabled();
  });
});

test("A user can save message-send and time-zone preferences", async () => {
  const updates = mockPreferences();

  await setupPage({ context, path: "/settings", host: "app.okou.ai" });

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

  const timezone = getFastRole("combobox", /UTC/u);
  click(timezone);
  const eastern = await screen.findByRole("option", {
    name: /Eastern Time \(ET\)$/u,
  });
  click(eastern);

  await waitFor(() => {
    expect(updates).toContainEqual({ timezone: "America/New_York" });
  });
});
