import { screen, waitFor, within } from "@testing-library/react";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { modelProviderCooldownDiagnosticsContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import {
  type UserLocale,
  type UserPreferencesResponse,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import {
  click,
  holdElementAnimations,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { OKOU_LOCALE_COOKIE_NAME } from "../../../i18n/locale-fallback.ts";
import frFRCommonUrl from "../../../i18n/locales/fr-FR/common.json?url";

const context = testContext();

async function openDialog(
  role: "admin" | "member" = "admin",
  section: "debug" | "general" | "model" | "preference" = "general",
  host = "localhost",
): Promise<void> {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role,
  });
  context.mocks.data.orgMembers({
    name: "Test Org",
    role,
    members: [],
    pendingInvitations: [],
    membershipRequests: [],
    createdAt: "2026-01-01T00:00:00Z",
  });
  await setupPage({
    context,
    host,
    path: `/?settings=${section}`,
    featureSwitches:
      section === "debug" ? { [FeatureSwitchKey.OkouDebug]: true } : {},
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

function createPreferences(
  locale: UserLocale | null,
  supportedLocales: UserLocale[] = [
    "en-US",
    "pt-BR",
    "ja-JP",
    "ko-KR",
    "id-ID",
    "de-DE",
    "es-ES",
    "it-IT",
    "fr-FR",
    "hi-IN",
  ],
): UserPreferencesResponse {
  return {
    timezone: null,
    locale,
    translationLanguage: null,
    supportedLocales,
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
    voiceInputModel: null,
  };
}

function connectorCatalogDisclosure(region: HTMLElement): {
  readonly details: HTMLDetailsElement;
  readonly summary: HTMLElement;
} {
  const title = within(region).getByText("Connector catalog");
  const summary = title.closest("summary");
  const details = summary?.closest("details");
  if (!(summary instanceof HTMLElement)) {
    throw new Error("Connector catalog summary not found");
  }
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Connector catalog disclosure not found");
  }
  return { details, summary };
}

function builtInModelCooldownDisclosure(region: HTMLElement): {
  readonly details: HTMLDetailsElement;
  readonly summary: HTMLElement;
} {
  const title = within(region).getByText("Built-in model fallback");
  const summary = title.closest("summary");
  const details = summary?.closest("details");
  if (!(summary instanceof HTMLElement)) {
    throw new Error("Built-in model cooldown summary not found");
  }
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Built-in model cooldown disclosure not found");
  }
  return { details, summary };
}

function indexedDbDisclosure(region: HTMLElement): {
  readonly details: HTMLDetailsElement;
  readonly summary: HTMLElement;
} {
  const title = within(region).getByText("IndexedDB storage");
  const summary = title.closest("summary");
  const details = summary?.closest("details");
  if (!(summary instanceof HTMLElement)) {
    throw new Error("IndexedDB diagnostics summary not found");
  }
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("IndexedDB diagnostics disclosure not found");
  }
  return { details, summary };
}

function buttonWithText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === text;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

async function openSupportedLanguagePicker() {
  let preferences = createPreferences("pt-BR", ["en-US", "pt-BR", "de-DE"]);
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences);
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    preferences = {
      ...preferences,
      ...body,
      supportedLocales:
        body.locale === undefined ? preferences.supportedLocales : ["en-US"],
    };
    return respond(200, preferences);
  });

  await openDialog("admin", "preference");

  click(await screen.findByRole("combobox", { name: "Idioma" }));
}

test("Offer only the workspace's supported languages", async () => {
  await openSupportedLanguagePicker();
  const languageOptions = within(screen.getByRole("listbox")).getAllByRole(
    "option",
  );
  expect(languageOptions).toHaveLength(3);
  expect(
    languageOptions.map((option) => {
      return option.textContent;
    }),
  ).toStrictEqual(["English", "Português (Brasil)", "Deutsch"]);
  expect(screen.queryByRole("option", { name: "Italiano" })).toBeNull();
});

test("Keep a saved single-language preference after closing and reopening Settings", async () => {
  await openSupportedLanguagePicker();
  click(screen.getByRole("option", { name: "English" }));

  await waitFor(() => {
    expect(document.documentElement.lang).toBe("en-US");
    expect(
      screen.queryByRole("combobox", { name: "Language" }),
    ).not.toBeInTheDocument();
  });

  const settingsDialog = screen.getByRole("dialog", { name: "Settings" });
  const finishCloseTransition = holdElementAnimations(settingsDialog);
  click(screen.getByLabelText("Close"));
  expect(
    new URL(window.location.href).searchParams.has("settings"),
  ).toBeFalsy();
  expect(settingsDialog).toBeVisible();
  finishCloseTransition();
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
  const rail = await screen.findByTestId("labeled-nav-rail");
  const accountButton = within(rail).getByLabelText("Test User");
  click(accountButton);
  const accountMenu = await screen.findByRole("menu");
  click(within(accountMenu).getByText("Settings"));

  await expect(
    screen.findByRole("dialog", { name: "Settings" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Language" }),
  ).not.toBeInTheDocument();
  expect(document.documentElement.lang).toBe("en-US");
});

test.each([
  {
    source: "browser",
    cookie: null,
    locale: "id-ID",
    label: "Bahasa",
    option: "Bahasa Indonesia",
  },
  {
    source: "site cookie",
    cookie: "v1.fr-FR",
    locale: "fr-FR",
    label: "Langue",
    option: "Français",
  },
])(
  "Persist the $source language when the workspace has no preference",
  async (scenario) => {
    let serverLocale: UserLocale | null = null;
    context.mocks.browser.cookie(
      scenario.cookie === null
        ? ""
        : `${OKOU_LOCALE_COOKIE_NAME}=${scenario.cookie}`,
    );
    context.mocks.browser.languages(["id-ID"]);
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        serverLocale = body.locale;
      }
      return respond(200, createPreferences(serverLocale));
    });

    await openDialog("admin", "preference", "app.okou.ai");

    const languageSelect = await screen.findByRole("combobox", {
      name: scenario.label,
    });
    await waitFor(() => {
      expect(serverLocale).toBe(scenario.locale);
      expect(languageSelect).toHaveTextContent(scenario.option);
      expect(languageSelect).toBeEnabled();
      expect(document.documentElement).toHaveAttribute("lang", scenario.locale);
    });

    click(languageSelect);
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(serverLocale).toBe("en-US");
      expect(document.documentElement).toHaveAttribute("lang", "en-US");
      expect(
        screen.getByRole("combobox", { name: "Language" }),
      ).toHaveTextContent("English");
    });
  },
);

test("Persist English when an initial locale hint is outside the API handshake", async () => {
  let serverLocale: UserLocale | null = null;
  const submittedLocales: UserLocale[] = [];
  const supportedLocales: UserLocale[] = ["en-US", "pt-BR"];
  context.mocks.browser.cookie(`${OKOU_LOCALE_COOKIE_NAME}=v1.fr-FR`);
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, createPreferences(serverLocale, supportedLocales));
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    if (body.locale !== undefined) {
      submittedLocales.push(body.locale);
      serverLocale = body.locale;
    }
    return respond(200, createPreferences(serverLocale, supportedLocales));
  });

  await openDialog("admin", "preference", "app.okou.ai");

  await waitFor(() => {
    expect(serverLocale).toBe("en-US");
    expect(document.documentElement).toHaveAttribute("lang", "en-US");
    expect(
      screen.getByRole("combobox", { name: "Language" }),
    ).toHaveTextContent("English");
  });
  expect(submittedLocales).not.toContain("fr-FR");
});

test("Keep settings usable and persist English when automatic locale assets fail", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  let serverLocale: UserLocale | null = null;
  context.mocks.browser.languages(["fr-FR"]);
  context.mocks.http.get(frFRCommonUrl, () => {
    return new HttpResponse(null, { status: 503 });
  });
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, createPreferences(serverLocale));
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    if (body.locale !== undefined) {
      serverLocale = body.locale;
    }
    return respond(200, createPreferences(serverLocale));
  });

  await openDialog("admin", "preference", "app.okou.ai");

  await waitFor(() => {
    expect(serverLocale).toBe("en-US");
    expect(
      screen.getByRole("combobox", { name: "Language" }),
    ).toHaveTextContent("English");
  });
  expect(document.documentElement).toHaveAttribute("lang", "en-US");
  expect(consoleError).toHaveBeenCalledWith(
    "[E][Locale]",
    "Failed to apply locale fallback fr-FR; falling back to en-US",
    expect.any(Error),
  );
});

test("Select and persist a supported interface language", async () => {
  const submittedLocales: UserLocale[] = [];
  let serverLocale: UserLocale | null = null;
  const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "de-DE"];
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, createPreferences(serverLocale, supportedLocales));
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    if (body.locale !== undefined) {
      serverLocale = body.locale;
      submittedLocales.push(body.locale);
    }
    return respond(200, createPreferences(serverLocale, supportedLocales));
  });

  await openDialog("admin", "preference");

  click(
    await screen.findByRole("combobox", {
      name: "Language",
    }),
  );
  click(screen.getByRole("option", { name: "Deutsch" }));

  await waitFor(() => {
    expect(submittedLocales).toContain("de-DE");
    expect(screen.getByRole("combobox", { name: "Sprache" })).toHaveTextContent(
      "Deutsch",
    );
    expect(document.documentElement.lang).toBe("de-DE");
  });
});

test("Keep the selected language visible during a preference refresh", async () => {
  const preferenceReloadStarted = context.mocks.deferred<void>();
  const preferenceReloadCompleted = context.mocks.deferred<void>();
  const releasePreferenceReload = context.mocks.deferred<void>();
  let holdPreferenceReload = false;
  let serverLocale: UserLocale | null = "en-US";
  const supportedLocales: UserLocale[] = ["en-US", "de-DE"];
  context.mocks.api(
    userPreferencesContract.get,
    async ({ respond, withSignal }) => {
      if (holdPreferenceReload) {
        preferenceReloadStarted.resolve();
        await withSignal(releasePreferenceReload.promise);
        preferenceReloadCompleted.resolve();
      }
      return respond(200, createPreferences(serverLocale, supportedLocales));
    },
  );
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    if (body.locale !== undefined) {
      serverLocale = body.locale;
    }
    return respond(200, createPreferences(serverLocale, supportedLocales));
  });

  await openDialog("admin", "preference");

  holdPreferenceReload = true;
  click(await screen.findByRole("combobox", { name: "Language" }));
  click(screen.getByRole("option", { name: "Deutsch" }));
  await preferenceReloadStarted.promise;

  expect(screen.getByRole("combobox", { name: "Sprache" })).toHaveTextContent(
    "Deutsch",
  );

  releasePreferenceReload.resolve();
  await preferenceReloadCompleted.promise;
  holdPreferenceReload = false;
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Sprache" })).toBeEnabled();
  });

  click(screen.getByRole("combobox", { name: "Sprache" }));
  click(screen.getByRole("option", { name: "English" }));
  await waitFor(() => {
    expect(document.documentElement.lang).toBe("en-US");
    expect(serverLocale).toBe("en-US");
  });
});

test("Use the saved workspace language ahead of locale hints", async () => {
  context.mocks.browser.cookie(`${OKOU_LOCALE_COOKIE_NAME}=v1.fr-FR`);
  context.mocks.browser.languages(["de-DE"]);
  context.mocks.data.userPreferences(createPreferences("id-ID"));

  await openDialog("admin", "preference", "app.okou.ai");

  const languageSelect = await screen.findByRole("combobox", {
    name: "Bahasa",
  });
  await waitFor(() => {
    expect(languageSelect).toHaveTextContent("Bahasa Indonesia");
    expect(languageSelect).toHaveAccessibleName("Bahasa");
    expect(document.documentElement.lang).toBe("id-ID");
  });

  click(languageSelect);
  click(screen.getByRole("option", { name: "English" }));
  await waitFor(() => {
    expect(document.documentElement.lang).toBe("en-US");
  });
});

test("Reject a stale language that the workspace does not support", async () => {
  const submittedLocales: UserLocale[] = [];
  document.documentElement.lang = "fr-FR";
  context.signal.addEventListener(
    "abort",
    () => {
      document.documentElement.lang = "en-US";
    },
    { once: true },
  );
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, createPreferences(null, ["en-US", "pt-BR"]));
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    if (body.locale !== undefined) {
      submittedLocales.push(body.locale);
    }
    return respond(
      200,
      createPreferences(body.locale ?? null, ["en-US", "pt-BR"]),
    );
  });

  await openDialog("admin", "preference");

  await waitFor(() => {
    expect(submittedLocales).toContain("en-US");
    expect(submittedLocales).not.toContain("fr-FR");
    expect(document.documentElement.lang).toBe("en-US");
    expect(
      screen.getByRole("combobox", { name: "Language" }),
    ).toHaveTextContent("English");
  });
});

test("Navigate workspace settings without closing Settings", async () => {
  await openDialog("admin");

  const dialog = screen.getByRole("dialog", { name: "Settings" });
  expect(within(dialog).getByText("Personal")).toBeInTheDocument();
  expect(within(dialog).getByText("Workspace")).toBeInTheDocument();
  expect(within(dialog).getAllByText("Models").length).toBeGreaterThan(0);
  expect(within(dialog).getByText("Billing & pricing")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();

  const peopleTab = queryAllByRoleFast("button", dialog).find((element) => {
    return /People/u.test(element.textContent ?? "");
  });
  if (!peopleTab) {
    throw new Error("People tab not found");
  }
  click(peopleTab);

  await waitFor(() => {
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
  });
});

test("Route members away from administrator-only workspace settings", async () => {
  await openDialog("member");

  const dialog = screen.getByRole("dialog");
  expect(within(dialog).queryByText("Workspace")).not.toBeInTheDocument();
  expect(screen.getByText("Theme")).toBeInTheDocument();
});

test("Inspect built-in model cooldown diagnostics", async () => {
  const releaseRefresh = context.mocks.deferred<void>();
  const refreshStarted = context.mocks.deferred<void>();
  let initialResponseServed = false;
  context.mocks.api(
    modelProviderCooldownDiagnosticsContract.get,
    async ({ respond }) => {
      if (initialResponseServed) {
        refreshStarted.resolve();
        await releaseRefresh.promise;
        return respond(200, {
          activeCooldowns: [],
        });
      }
      initialResponseServed = true;
      return respond(200, {
        activeCooldowns: [
          {
            selectedModel: "gpt-5.6-luna",
            providerType: "openai-api-key",
            upstreamModel: "gpt-5.6-luna-2026-08-01",
            unavailableUntil: "2026-08-23T04:05:00.000Z",
          },
        ],
      });
    },
  );

  await openDialog("admin", "debug");

  const diagnostics = await screen.findByRole("region", {
    name: "Built-in model fallback",
  });
  const { details, summary } = builtInModelCooldownDisclosure(diagnostics);
  expect(details.open).toBeFalsy();
  expect(summary).toHaveTextContent("global active cooldowns: 1");
  expect(
    within(diagnostics).queryByText("gpt-5.6-luna-2026-08-01"),
  ).not.toBeVisible();

  click(summary);
  expect(details.open).toBeTruthy();
  expect(within(diagnostics).getByText("gpt-5.6-luna")).toBeInTheDocument();
  expect(within(diagnostics).getByText("openai-api-key")).toBeInTheDocument();
  expect(
    within(diagnostics).getByText("gpt-5.6-luna-2026-08-01"),
  ).toBeInTheDocument();
  expect(
    within(diagnostics).getByText("2026-08-23T04:05:00.000Z"),
  ).toHaveAttribute("datetime", "2026-08-23T04:05:00.000Z");
  expect(
    queryAllByRoleFast("button", diagnostics).some((button) => {
      return button.textContent?.trim() === "Cancel cooldown";
    }),
  ).toBeFalsy();

  const refreshButton = queryAllByRoleFast("button", diagnostics).find(
    (button) => {
      return button.textContent?.trim() === "Refresh";
    },
  );
  if (!refreshButton) {
    throw new Error("Built-in model cooldown refresh button not found");
  }
  click(refreshButton);
  await refreshStarted.promise;
  expect(refreshButton).toBeDisabled();
  expect(details.open).toBeTruthy();
  expect(
    within(diagnostics).getByText("gpt-5.6-luna-2026-08-01"),
  ).toBeInTheDocument();

  releaseRefresh.resolve();
  await waitFor(() => {
    expect(summary).toHaveTextContent("global active cooldowns: 0");
    expect(refreshButton).toBeEnabled();
  });
  expect(details.open).toBeTruthy();
  expect(
    within(diagnostics).getByText(
      "No built-in model routes are currently in global cooldown.",
    ),
  ).toBeInTheDocument();
});

test("Inspect empty IndexedDB storage before the first snapshot arrives", async () => {
  const releaseSnapshot = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
    await releaseSnapshot.promise;
    return respond(200, {
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  await setupPage({
    context,
    path: "/?settings=debug",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    sharedWorkerTestTransport: "message-port",
  });
  await screen.findByRole("dialog", { name: "Settings" });

  const diagnostics = await screen.findByRole("region", {
    name: "IndexedDB storage",
  });
  await waitFor(() => {
    expect(
      within(diagnostics).getByText("IndexedDB storage").closest("summary"),
    ).not.toBeNull();
  });
  const { details, summary } = indexedDbDisclosure(diagnostics);
  expect(details.open).toBeFalsy();
  expect(summary).toHaveTextContent("object stores: 5");
  expect(summary).toHaveTextContent("records: 0");

  click(summary);
  expect(details.open).toBeTruthy();
  for (const storeName of [
    "chat_events",
    "chat_event_cursors",
    "chat_thread_snapshot",
    "chat_thread_events",
    "chat_thread_event_sync",
  ]) {
    const row = within(diagnostics).getByText(storeName).parentElement;
    if (!row) {
      throw new Error(`Expected record count for ${storeName}`);
    }
    expect(within(row).getByRole("definition")).toHaveTextContent(/^0$/u);
  }
  expect(within(diagnostics).getAllByRole("definition")).toHaveLength(5);
  expect(
    within(diagnostics).queryByText("Threads in snapshot"),
  ).not.toBeInTheDocument();
  const snapshot = within(diagnostics).getByRole("region", {
    name: "Thread snapshot",
  });
  click(buttonWithText(snapshot, "Measure snapshot"));
  await expect(
    within(snapshot).findByRole("status"),
  ).resolves.toHaveTextContent("No cached thread snapshot.");
  expect(within(snapshot).queryByRole("definition")).not.toBeInTheDocument();
});

test("Measure the threads inside a singleton snapshot on demand", async () => {
  const agentId = crypto.randomUUID();
  const snapshotRequested = context.mocks.deferred<void>();
  const releaseSnapshot = context.mocks.deferred<void>();
  context.mocks.data.agents([{ agentId }]);
  context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
    if (!snapshotRequested.settled()) {
      snapshotRequested.resolve();
    }
    await releaseSnapshot.promise;
    return respond(200, {
      chatThreads: ["Snapshot 文 😀", "Second thread", "Third thread"].map(
        (title) => {
          return {
            id: crypto.randomUUID(),
            agentId,
            title,
            sortAt: "2026-09-05T00:00:00Z",
            createdAt: "2026-09-05T00:00:00Z",
            updatedAt: "2026-09-05T00:00:00Z",
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
            selectedVideoModel: null,
          };
        },
      ),
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    sharedWorkerTestTransport: "message-port",
  });
  const sidebar = await screen.findByTestId("sidebar-scroll-area");
  // Page content can render before the Worker requests its first snapshot.
  // Release it after both are ready, then observe the committed snapshot.
  await snapshotRequested.promise;
  expect(within(sidebar).queryByText("Snapshot 文 😀")).not.toBeInTheDocument();
  releaseSnapshot.resolve();
  await within(sidebar).findByText("Snapshot 文 😀");
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Test User"));
  const accountMenu = await screen.findByRole("menu");
  click(within(accountMenu).getByText("Settings"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  click(buttonWithText(dialog, "Debug"));
  const diagnostics = await screen.findByRole("region", {
    name: "IndexedDB storage",
  });
  const { details, summary } = await waitFor(() => {
    return indexedDbDisclosure(diagnostics);
  });
  click(summary);
  const snapshot = within(diagnostics).getByRole("region", {
    name: "Thread snapshot",
  });
  expect(within(snapshot).queryByRole("definition")).not.toBeInTheDocument();

  click(buttonWithText(snapshot, "Measure snapshot"));
  await within(snapshot).findByText("Threads in snapshot");
  const values = within(snapshot).getAllByRole("definition");
  expect(values[0]).toHaveTextContent("3");
  expect(values[1]).toHaveTextContent(/^[1-9][\d.]*KB$/u);
  expect(values[2]).toHaveTextContent(/^[\d,.]+ ms$/u);

  click(buttonWithText(diagnostics, "Refresh"));
  await waitFor(() => {
    expect(buttonWithText(diagnostics, "Refresh")).toBeEnabled();
    expect(within(snapshot).queryByRole("definition")).not.toBeInTheDocument();
  });
  expect(details.open).toBeTruthy();
  const snapshotRow = within(diagnostics).getByText(
    "chat_thread_snapshot",
  ).parentElement;
  if (!snapshotRow) {
    throw new Error("Expected snapshot record count");
  }
  expect(within(snapshotRow).getByRole("definition")).toHaveTextContent("1");

  click(buttonWithText(snapshot, "Measure snapshot"));
  await within(snapshot).findByText("Threads in snapshot");
  expect(within(snapshot).getAllByRole("definition")[0]).toHaveTextContent("3");
});

test("Cancel a global built-in model cooldown as staff", async () => {
  const releaseCancellation = context.mocks.deferred<void>();
  const cancellationStarted = context.mocks.deferred<void>();
  let cooldownActive = true;
  let cancellationBody: {
    readonly selectedModel: string;
    readonly providerType: string;
    readonly upstreamModel: string;
  } | null = null;
  context.mocks.api(
    modelProviderCooldownDiagnosticsContract.get,
    ({ respond }) => {
      return respond(200, {
        canCancelCooldowns: true,
        activeCooldowns: cooldownActive
          ? [
              {
                selectedModel: "gpt-5.6-luna",
                providerType: "openai-api-key",
                upstreamModel: "gpt-5.6-luna-2026-08-01",
                unavailableUntil: "2026-08-23T04:05:00.000Z",
              },
            ]
          : [],
      });
    },
  );
  context.mocks.api(
    modelProviderCooldownDiagnosticsContract.cancel,
    async ({ body, respond }) => {
      cancellationBody = body;
      cancellationStarted.resolve();
      await releaseCancellation.promise;
      cooldownActive = false;
      return respond(204);
    },
  );

  await openDialog("admin", "debug");

  const diagnostics = await screen.findByRole("region", {
    name: "Built-in model fallback",
  });
  const { details, summary } = builtInModelCooldownDisclosure(diagnostics);
  click(summary);
  expect(details.open).toBeTruthy();

  click(buttonWithText(diagnostics, "Cancel cooldown"));
  const confirmation = await screen.findByRole("dialog", {
    name: "Cancel global cooldown?",
  });
  expect(cancellationBody).toBeNull();
  expect(within(confirmation).getByText("gpt-5.6-luna")).toBeVisible();
  expect(within(confirmation).getByText("openai-api-key")).toBeVisible();
  expect(
    within(confirmation).getByText("gpt-5.6-luna-2026-08-01"),
  ).toBeVisible();
  expect(
    within(confirmation).getByText(
      "Cancelling this global cooldown makes the route immediately eligible for every workspace.",
    ),
  ).toBeVisible();
  expect(
    within(confirmation).getByText(
      "A later qualifying failure can place this route back in cooldown.",
    ),
  ).toBeVisible();

  click(buttonWithText(confirmation, "Cancel cooldown"));
  await cancellationStarted.promise;
  expect(buttonWithText(confirmation, "Cancelling...")).toBeDisabled();
  expect(buttonWithText(confirmation, "Keep cooldown")).toBeDisabled();
  expect(cancellationBody).toStrictEqual({
    selectedModel: "gpt-5.6-luna",
    providerType: "openai-api-key",
    upstreamModel: "gpt-5.6-luna-2026-08-01",
  });

  releaseCancellation.resolve();
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Cancel global cooldown?" }),
    ).not.toBeInTheDocument();
    expect(summary).toHaveTextContent("global active cooldowns: 0");
  });
  expect(details.open).toBeTruthy();
  expect(
    within(diagnostics).getByText(
      "No built-in model routes are currently in global cooldown.",
    ),
  ).toBeInTheDocument();
});

test("Refresh model cooldown diagnostics on each Debug entry", async () => {
  let showUpdatedDiagnostics = false;
  context.mocks.api(
    modelProviderCooldownDiagnosticsContract.get,
    ({ respond }) => {
      return respond(200, {
        activeCooldowns: showUpdatedDiagnostics
          ? [
              {
                selectedModel: "gpt-5.6-luna",
                providerType: "openai-api-key",
                upstreamModel: "gpt-5.6-luna-2026-08-01",
                unavailableUntil: "2026-08-23T04:05:00.000Z",
              },
            ]
          : [],
      });
    },
  );

  await openDialog("admin", "debug");

  const diagnostics = await screen.findByRole("region", {
    name: "Built-in model fallback",
  });
  const disclosure = builtInModelCooldownDisclosure(diagnostics);
  expect(disclosure.summary).toHaveTextContent("global active cooldowns: 0");
  click(disclosure.summary);
  expect(
    within(diagnostics).getByText(
      "No built-in model routes are currently in global cooldown.",
    ),
  ).toBeInTheDocument();

  const dialog = screen.getByRole("dialog");
  const dialogButton = (label: string): HTMLElement => {
    const button = queryAllByRoleFast("button", dialog).find((candidate) => {
      return (
        candidate.textContent?.trim() === label ||
        candidate.getAttribute("aria-label") === label
      );
    });
    if (!button) {
      throw new Error(`${label} button not found`);
    }
    return button;
  };

  click(dialogButton("Preference"));
  await expect(
    screen.findByRole("heading", { name: "Preference" }),
  ).resolves.toBeInTheDocument();
  showUpdatedDiagnostics = true;
  click(dialogButton("Debug"));
  await waitFor(() => {
    const updatedDiagnostics = screen.getByRole("region", {
      name: "Built-in model fallback",
    });
    const updatedDisclosure =
      builtInModelCooldownDisclosure(updatedDiagnostics);
    expect(updatedDisclosure.details.open).toBeFalsy();
    expect(updatedDisclosure.summary).toHaveTextContent(
      "global active cooldowns: 1",
    );
  });
});

test("Keep Debug usable while model cooldown diagnostics are unavailable", async () => {
  const releaseDiagnostics = context.mocks.deferred<void>();
  const refreshStarted = context.mocks.deferred<void>();
  let initialRequest = true;
  context.mocks.api(
    modelProviderCooldownDiagnosticsContract.get,
    async ({ respond }) => {
      if (initialRequest) {
        initialRequest = false;
        await releaseDiagnostics.promise;
      } else {
        refreshStarted.resolve();
      }
      return respond(404, {
        error: {
          message: "Built-in model cooldown diagnostics are unavailable",
          code: "NOT_FOUND",
        },
      });
    },
  );

  await openDialog("admin", "debug");

  const diagnostics = await screen.findByRole("region", {
    name: "Built-in model fallback",
  });
  expect(
    within(diagnostics).getByText(
      "Loading built-in model cooldown diagnostics...",
    ),
  ).toBeInTheDocument();
  expect(diagnostics.querySelector("summary")).toBeNull();
  expect(screen.getByText("Build information")).toBeInTheDocument();
  expect(screen.getByText("Capture network bodies")).toBeInTheDocument();

  releaseDiagnostics.resolve();
  await expect(
    within(diagnostics).findByText(
      "Built-in model cooldown diagnostics are unavailable.",
    ),
  ).resolves.toBeInTheDocument();
  expect(diagnostics.querySelector("summary")).toBeNull();

  const refreshButton = queryAllByRoleFast("button", diagnostics).find(
    (button) => {
      return button.textContent?.trim() === "Refresh";
    },
  );
  if (!refreshButton) {
    throw new Error("Built-in model cooldown refresh button not found");
  }
  click(refreshButton);
  await refreshStarted.promise;
  await expect(
    within(diagnostics).findByText(
      "Built-in model cooldown diagnostics are unavailable.",
    ),
  ).resolves.toBeInTheDocument();
});

test("Inspect connector catalog diagnostics", async () => {
  await openDialog("admin", "debug");

  const diagnostics = await screen.findByRole("region", {
    name: "Connector catalog",
  });
  const { details, summary } = connectorCatalogDisclosure(diagnostics);
  expect(details.open).toBeFalsy();
  expect(summary).toHaveTextContent("Sync state: Stale");
  expect(summary).toHaveTextContent("Active version: 2026-07-25.1");
  expect(summary).toHaveTextContent("Last attempt: Rejected");
  expect(summary).toHaveTextContent("Evaluation: Current");

  click(summary);
  expect(details.open).toBeTruthy();
  expect(within(diagnostics).getByText("2026-07-25.2")).toBeInTheDocument();
  expect(within(diagnostics).getByText("1.319.0")).toBeInTheDocument();
  expect(within(diagnostics).getByText("Reused")).toBeInTheDocument();
  expect(within(diagnostics).getAllByText("Invalid artifact")).toHaveLength(2);
  expect(within(diagnostics).getByText("github / oauth")).toBeInTheDocument();
  expect(
    within(diagnostics).getByText("Missing revoke provider"),
  ).toBeInTheDocument();
  expect(within(diagnostics).getByText("Missing versions")).toBeInTheDocument();
  expect(within(diagnostics).getByText("Unowned secrets")).toBeInTheDocument();
  expect(
    within(diagnostics).getByText("Unowned variables"),
  ).toBeInTheDocument();
  expect(
    within(diagnostics).getByText("Unresolved bridge credentials"),
  ).toBeInTheDocument();

  click(summary);
  expect(details.open).toBeFalsy();
});

test("Summarize a connector catalog that has never synced", async () => {
  context.mocks.api(connectorCatalogContract.diagnostics, ({ respond }) => {
    return respond(200, {
      state: "never-synced",
      active: null,
      lastAttempt: null,
      lastSuccessAt: null,
      rejectedCandidate: null,
      filtering: {
        capabilityDigest: `sha256:${"a".repeat(64)}`,
        evaluatedAt: null,
        stale: true,
        filteredAuthMethods: [],
      },
      credentialStorage: {
        missingConnectorVersions: 0,
        unownedConnectorSecrets: 0,
        unownedConnectorVariables: 0,
        unresolvedBridgeCredentials: 0,
      },
    });
  });

  await openDialog("admin", "debug");

  const diagnostics = await screen.findByRole("region", {
    name: "Connector catalog",
  });
  const { details, summary } = connectorCatalogDisclosure(diagnostics);
  expect(details.open).toBeFalsy();
  expect(summary).toHaveTextContent("Sync state: Never synced");
  expect(summary).toHaveTextContent("Active version: None");
  expect(summary).toHaveTextContent("Last attempt: None");
  expect(summary).toHaveTextContent("Evaluation: Stale");
});

test("Refresh connector diagnostics on each Debug entry", async () => {
  let catalogVersion = "2026-08-19.1";
  context.mocks.api(connectorCatalogContract.diagnostics, ({ respond }) => {
    const requestedAt = "2026-08-19T04:00:00.000Z";
    return respond(200, {
      state: "current",
      active: {
        catalogVersion,
        catalogDigest: `sha256:${"a".repeat(64)}`,
        activatedAt: requestedAt,
      },
      lastAttempt: {
        at: requestedAt,
        outcome: "accepted",
        failureCode: null,
        reusedCachedRejection: false,
      },
      lastSuccessAt: requestedAt,
      rejectedCandidate: null,
      filtering: {
        capabilityDigest: `sha256:${"b".repeat(64)}`,
        evaluatedAt: requestedAt,
        stale: false,
        filteredAuthMethods: [],
      },
      credentialStorage: {
        missingConnectorVersions: 0,
        unownedConnectorSecrets: 0,
        unownedConnectorVariables: 0,
        unresolvedBridgeCredentials: 0,
      },
    });
  });

  await openDialog("admin", "debug");

  const diagnostics = await screen.findByRole("region", {
    name: "Connector catalog",
  });
  const { details, summary } = connectorCatalogDisclosure(diagnostics);
  expect(summary).toHaveTextContent("Active version: 2026-08-19.1");

  click(summary);
  expect(details.open).toBeTruthy();

  click(screen.getByRole("switch"));
  await expect(
    screen.findByText("Enabled for the next 3 runs"),
  ).resolves.toBeInTheDocument();
  expect(summary).toHaveTextContent("Active version: 2026-08-19.1");

  const dialog = screen.getByRole("dialog");
  const dialogButton = (label: string): HTMLElement => {
    const button = queryAllByRoleFast("button", dialog).find((candidate) => {
      return (
        candidate.textContent?.trim() === label ||
        candidate.getAttribute("aria-label") === label
      );
    });
    if (!button) {
      throw new Error(`${label} button not found`);
    }
    return button;
  };

  click(dialogButton("Preference"));
  await expect(
    screen.findByRole("heading", { name: "Preference" }),
  ).resolves.toBeInTheDocument();

  catalogVersion = "2026-08-19.2";
  click(dialogButton("Debug"));
  await waitFor(() => {
    const updatedDiagnostics = screen.getByRole("region", {
      name: "Connector catalog",
    });
    const updatedDisclosure = connectorCatalogDisclosure(updatedDiagnostics);
    expect(updatedDisclosure.summary).toHaveTextContent(
      "Active version: 2026-08-19.2",
    );
    expect(updatedDisclosure.details.open).toBeFalsy();
  });
});

test("Distinguish an uncached connector-catalog rejection", async () => {
  context.mocks.api(connectorCatalogContract.diagnostics, ({ respond }) => {
    return respond(200, {
      state: "stale",
      active: {
        catalogVersion: "2026-07-25.1",
        catalogDigest: `sha256:${"a".repeat(64)}`,
        activatedAt: "2026-07-25T01:00:00.000Z",
      },
      lastAttempt: {
        at: "2026-07-25T02:00:00.000Z",
        outcome: "rejected",
        failureCode: "source-unavailable",
        reusedCachedRejection: false,
      },
      lastSuccessAt: "2026-07-25T01:00:00.000Z",
      rejectedCandidate: null,
      filtering: {
        capabilityDigest: `sha256:${"b".repeat(64)}`,
        evaluatedAt: "2026-07-25T01:00:00.000Z",
        stale: false,
        filteredAuthMethods: [],
      },
      credentialStorage: {
        missingConnectorVersions: 0,
        unownedConnectorSecrets: 0,
        unownedConnectorVariables: 0,
        unresolvedBridgeCredentials: 0,
      },
    });
  });

  await openDialog("admin", "debug");

  const diagnostics = await screen.findByRole("region", {
    name: "Connector catalog",
  });
  const { summary } = connectorCatalogDisclosure(diagnostics);
  click(summary);
  expect(within(diagnostics).getByText("Not reused")).toBeInTheDocument();
  expect(
    within(diagnostics).queryByText("Fresh evaluation"),
  ).not.toBeInTheDocument();
});

test("Keep Debug usable while connector diagnostics are unavailable", async () => {
  const releaseDiagnostics = context.mocks.deferred<void>();
  context.mocks.api(
    connectorCatalogContract.diagnostics,
    async ({ respond }) => {
      await releaseDiagnostics.promise;
      return respond(404, {
        error: {
          message: "Connector catalog diagnostics are unavailable",
          code: "NOT_FOUND",
        },
      });
    },
  );

  await openDialog("admin", "debug");

  const diagnostics = await screen.findByRole("region", {
    name: "Connector catalog",
  });
  expect(within(diagnostics).getByText("Loading")).toBeInTheDocument();
  expect(diagnostics.querySelector("summary")).toBeNull();
  expect(screen.getByText("Build information")).toBeInTheDocument();
  expect(screen.getByText("Capture network bodies")).toBeInTheDocument();

  releaseDiagnostics.resolve();
  await expect(
    within(diagnostics).findByText("Unavailable"),
  ).resolves.toBeInTheDocument();
  expect(diagnostics.querySelector("summary")).toBeNull();
});
