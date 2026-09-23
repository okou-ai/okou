import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { modelProviderCooldownDiagnosticsContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import {
  type UserLocale,
  type UserPreferencesResponse,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  setupPage,
  startPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { OKOU_LOCALE_COOKIE_NAME } from "../../../i18n/locale-fallback.ts";

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
    "zh-Hans",
    "zh-Hant",
  ],
): UserPreferencesResponse {
  return {
    timezone: "America/Los_Angeles",
    locale,
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

function mockMissingLocaleInitialization(
  preferences: () => UserPreferencesResponse,
  saveLocale: (locale: UserLocale) => void,
): void {
  context.mocks.api(userPreferencesContract.initialize, ({ body, respond }) => {
    const current = preferences();
    if (current.locale === null) {
      const requested = body.locale ?? "en-US";
      saveLocale(
        current.supportedLocales.includes(requested) ? requested : "en-US",
      );
    }
    return respond(200, preferences());
  });
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

test("Persist the browser language when the workspace has no preference", async () => {
  let serverLocale: UserLocale | null = null;
  context.mocks.browser.languages(["id-ID"]);
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, createPreferences(serverLocale));
  });
  mockMissingLocaleInitialization(
    () => {
      return createPreferences(serverLocale);
    },
    (locale) => {
      serverLocale = locale;
    },
  );
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    if (body.locale !== undefined) {
      serverLocale = body.locale;
    }
    return respond(200, createPreferences(serverLocale));
  });

  await openDialog("admin", "preference", "app.okou.ai");

  const languageSelect = await screen.findByRole("combobox", {
    name: "Bahasa",
  });
  await waitFor(() => {
    expect(serverLocale).toBe("id-ID");
    expect(languageSelect).toHaveTextContent("Bahasa Indonesia");
    expect(languageSelect).toBeEnabled();
    expect(document.documentElement).toHaveAttribute("lang", "id-ID");
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
});

test("Select and persist a supported interface language", async () => {
  const submittedLocales: UserLocale[] = [];
  let serverLocale: UserLocale | null = "en-US";
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

test("Navigate workspace settings with the named section select", async () => {
  const user = userEvent.setup({ delay: null });
  await openDialog("admin");
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const section = within(dialog).getByRole("combobox", {
    name: "Settings section",
  });
  expect(section).toHaveTextContent("General");

  section.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("option", { name: "General", selected: true });
  await user.keyboard("{ArrowDown}{Enter}");

  await expect(
    screen.findByRole("heading", { name: "People" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(window.location.search).toBe("?settings=people");
  const peopleSection = within(dialog).getByRole("combobox", {
    name: "Settings section",
  });
  expect(peopleSection).toHaveTextContent("People");
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

async function setupSnapshotMeasurement() {
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
  const page = await startPage({
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
  await page.ready;
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
  return { diagnostics, details, snapshot };
}

test("Measure the threads inside a singleton snapshot on demand", async () => {
  const { snapshot } = await setupSnapshotMeasurement();
  click(buttonWithText(snapshot, "Measure snapshot"));
  await within(snapshot).findByText("Threads in snapshot");
  const values = within(snapshot).getAllByRole("definition");
  expect(values[0]).toHaveTextContent("3");
  expect(values[1]).toHaveTextContent(/^[1-9][\d.]*KB$/u);
  expect(values[2]).toHaveTextContent(/^[\d,.]+ ms$/u);
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
