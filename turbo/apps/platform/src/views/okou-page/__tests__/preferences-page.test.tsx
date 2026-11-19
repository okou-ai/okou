import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { act, screen, waitFor } from "@testing-library/react";
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
    pinnedAgentIds: [],
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
    path: "/agents?settings=preference",
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
    path: "/agents?settings=preference",
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
