import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
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
import {
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
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
    memoryInitialized: true,
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

  click(await screen.findByRole("combobox", { name: "Language" }));
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
    if (serverLocale === null) {
      return respond(409, {
        error: {
          code: "USER_PREFERENCES_UNINITIALIZED",
          message: "User preferences require timezone or locale initialization",
        },
      });
    }
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
    name: "Language",
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
    expect(
      screen.getByRole("combobox", { name: "Language" }),
    ).toHaveTextContent("Deutsch");
    expect(document.documentElement.lang).toBe("de-DE");
  });
});

test("Use the saved workspace language ahead of locale hints", async () => {
  context.mocks.browser.cookie(`${OKOU_LOCALE_COOKIE_NAME}=v1.fr-FR`);
  context.mocks.browser.languages(["de-DE"]);
  context.mocks.data.userPreferences(createPreferences("id-ID"));

  await openDialog("admin", "preference", "app.okou.ai");

  const languageSelect = await screen.findByRole("combobox", {
    name: "Language",
  });
  await waitFor(() => {
    expect(languageSelect).toHaveTextContent("Bahasa Indonesia");
    expect(languageSelect).toHaveAccessibleName("Language");
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
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
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
              archived: false,
              renamedAt: null,
              selectedModel: null,
              serviceTier: null,
              computerUseHostId: null,
            };
          },
        ),
        latestEventId: null,
        latestSeqId: null,
      }),
    );
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

test("Inspect connector catalog diagnostics", async () => {
  await openDialog("admin", "debug");

  const diagnostics = await screen.findByRole("region", {
    name: "Connector catalog",
  });
  const { details, summary } = connectorCatalogDisclosure(diagnostics);
  expect(details.open).toBeFalsy();
  expect(summary).toHaveTextContent("Sync state: Current");
  expect(summary).toHaveTextContent(
    `Active catalog digest: sha256:${"a".repeat(64)}`,
  );
  expect(summary).toHaveTextContent("Entries: 2");
  expect(summary).toHaveTextContent("Evaluation: Current");

  click(summary);
  expect(details.open).toBeTruthy();
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

test("Flag a connector catalog generation without entries as unavailable", async () => {
  const hash = `sha256:${"c".repeat(64)}`;
  context.mocks.api(connectorCatalogContract.diagnostics, ({ respond }) => {
    return respond(200, {
      schemaVersion: 4,
      state: "current",
      active: { catalogDigest: hash },
      pointer: { schemaVersion: 4, hash, entryCount: 0 },
      filtering: {
        capabilityDigest: `sha256:${"b".repeat(64)}`,
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
  const { summary } = connectorCatalogDisclosure(diagnostics);
  expect(summary).toHaveTextContent("Sync state: Current");
  expect(summary).toHaveTextContent("Entries: Unavailable");
  expect(summary).toHaveTextContent("Evaluation: Stale");
});
