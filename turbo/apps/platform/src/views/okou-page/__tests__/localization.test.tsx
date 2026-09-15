import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import {
  SUPPORTED_USER_LOCALES,
  type UserPreferencesResponse,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import frFRAgents from "../../../i18n/locales/fr-FR/agents.json";
import frFRAgentsUrl from "../../../i18n/locales/fr-FR/agents.json?url";
import frFRCommonUrl from "../../../i18n/locales/fr-FR/common.json?url";
import itITCommonUrl from "../../../i18n/locales/it-IT/common.json?url";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  context as chatContext,
  mockAgent,
  mockOrgModelRoutes,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

function preferences(
  overrides: Partial<UserPreferencesResponse> = {},
): UserPreferencesResponse {
  return {
    timezone: "UTC",
    locale: "en-US",
    translationLanguage: null,
    supportedLocales: [...SUPPORTED_USER_LOCALES],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
    voiceInputModel: null,
    ...overrides,
  };
}

async function waitForSettings(): Promise<void> {
  await expect(screen.findByText("Language")).resolves.toBeInTheDocument();
}

function accountMenuTrigger(): HTMLElement | undefined {
  const rail = screen.queryByTestId("labeled-nav-rail");
  if (rail) {
    return within(rail).queryByLabelText("Test User") ?? undefined;
  }
  return queryAllByRoleFast("button").find((button) => {
    return button.textContent?.includes("Test User") ?? false;
  });
}

function fastRoleElement(
  role: "button" | "combobox" | "link" | "option",
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
    throw new Error(`Expected ${role} named ${String(name)}`);
  }
  return element;
}

function waitForFastRole(
  role: "button" | "combobox" | "link" | "option",
  name: string | RegExp,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    return fastRoleElement(role, name, container);
  });
}

function clerkProviderLocalization(): string | undefined {
  return screen.getByTestId("clerk-provider-config").dataset
    .clerkSignInStartActionLink;
}

async function selectLanguage(
  currentLabel: string,
  optionLabel: string,
): Promise<void> {
  click(await waitForFastRole("combobox", currentLabel));
  click(await waitForFastRole("option", optionLabel));
}

async function openSettingsDialog(label: string): Promise<HTMLElement> {
  const trigger = await waitFor(() => {
    const button = accountMenuTrigger();
    if (!button) {
      throw new Error("Expected the account menu trigger");
    }
    return button;
  });
  click(trigger);
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText(label));
  return screen.findByRole("dialog", { name: label });
}

async function closeDialog(dialog: HTMLElement, label: string): Promise<void> {
  click(fastRoleElement("button", label, dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
}

test("Authentication copy falls back without changing the app language", async () => {
  const clerk = context.mocks.clerk();
  vi.spyOn(console, "error").mockImplementation(() => {});
  clerk.localizationUnavailable("pt-BR");
  await setupPage({
    context,
    path: "/agents?settings=preference",
    locale: "pt-BR",
  });

  await expect(
    screen.findByRole("heading", { name: "Preferência" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Escolha seu idioma preferido para a interface do Okou"),
  ).toBeVisible();
  expect(document.documentElement).toHaveAttribute("lang", "pt-BR");
  expect(clerk.localizationRequests).toStrictEqual(["pt-BR"]);
});

test("A cancelled language change does not apply late", async () => {
  let requestStarted = false;
  let requestCancelled = false;
  context.mocks.http.get(itITCommonUrl, ({ never, request }) => {
    requestStarted = true;
    request.signal.addEventListener(
      "abort",
      () => {
        requestCancelled = true;
      },
      { once: true },
    );
    return never();
  });
  await setupPage({ context, path: "/settings" });
  await waitForSettings();

  await selectLanguage("Language", "Italiano");
  await waitFor(() => {
    expect(requestStarted).toBeTruthy();
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await closeDialog(settings, "Close");
  click(fastRoleElement("link", "Connectors"));

  await waitFor(() => {
    expect(requestCancelled).toBeTruthy();
  });
  await expect(
    screen.findByRole("heading", { name: "Connectors" }),
  ).resolves.toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute("lang", DEFAULT_LOCALE);
  expect(screen.queryByText("Lingua")).not.toBeInTheDocument();
});

test("A failed language download falls back without blocking chat", async () => {
  const resourceRequests: string[] = [];
  for (const url of [frFRCommonUrl, frFRAgentsUrl]) {
    chatContext.mocks.http.get(url, ({ request }) => {
      resourceRequests.push(new URL(request.url).pathname);
      return new HttpResponse(null, { status: 503 });
    });
  }
  const storedPreferences = preferences({ locale: "fr-FR" });
  chatContext.mocks.data.userPreferences(storedPreferences);
  let preferenceUpdates = 0;
  chatContext.mocks.api(userPreferencesContract.update, ({ respond }) => {
    preferenceUpdates += 1;
    return respond(200, storedPreferences);
  });
  chatContext.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  mockOrgModelRoutes("claude-fable-5-1");
  mockAgent();
  mockChatLifecycle(chatContext);

  await setupPage({ context: chatContext, path: `/agents/${AGENT_ID}/chat` });

  await expect(
    screen.findByText("Ask me to automate workflows, manage tasks..."),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Attach")).toBeVisible();
  expect(document.documentElement).toHaveAttribute("lang", DEFAULT_LOCALE);
  expect(resourceRequests).toHaveLength(2);
  expect(preferenceUpdates).toBe(0);
});

test("A failed runtime language change keeps the current language", async () => {
  let frenchDownloads = 0;
  context.mocks.http.get(frFRCommonUrl, () => {
    frenchDownloads += 1;
    return new HttpResponse(null, { status: 503 });
  });
  await setupPage({ context, path: "/settings" });
  await waitForSettings();

  await selectLanguage("Language", "Français");

  await waitFor(() => {
    expect(frenchDownloads).toBe(1);
    expect(document.documentElement).toHaveAttribute("lang", DEFAULT_LOCALE);
    expect(screen.getByText("Language")).toBeVisible();
  });
  expect(screen.queryByText("Langue")).not.toBeInTheDocument();
});

test("French uses local formatting and plurals", async () => {
  const frenchSidebar = Object.fromEntries(
    Object.entries(frFRAgents.sidebar).filter(([key]) => {
      return key !== "pinned";
    }),
  );
  context.mocks.http.get(frFRAgentsUrl, () => {
    return HttpResponse.json({
      ...frFRAgents,
      sidebar: frenchSidebar,
    });
  });
  const runId = "94000000-0000-4000-a000-000000000001";
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: runId,
      sessionId: null,
      agentId: null,
      displayName: null,
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "completed",
      prompt: "Read two files",
      appendSystemPrompt: null,
      error: null,
      createdAt: "2026-01-01T12:00:00.000Z",
      startedAt: "2026-01-01T12:00:00.000Z",
      completedAt: "2026-01-01T12:00:01.200Z",
      artifact: { name: null, version: null },
    });
  });
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(200, {
      events: [
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "read-one",
                  name: "Read",
                  input: { file_path: "/tmp/one.txt" },
                },
                {
                  type: "tool_use",
                  id: "read-two",
                  name: "Read",
                  input: { file_path: "/tmp/two.txt" },
                },
              ],
            },
          },
          createdAt: "2026-01-01T12:00:00.500Z",
        },
      ],
      hasMore: false,
      nextCursor: null,
      status: "completed",
      lastEventSequence: 1,
    });
  });
  await setupPage({ context, path: `/activities/${runId}` });
  const activityLabels = await screen.findAllByText("Read two files");
  expect(activityLabels).not.toHaveLength(0);

  const settings = await openSettingsDialog("Settings");
  await selectLanguage("Language", "Français");
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", "fr-FR");
    expect(within(settings).getByText("Langue")).toBeVisible();
  });
  await closeDialog(settings, "Fermer");

  expect(screen.getByText("2 fichiers")).toBeVisible();
  expect(screen.getByText("1,2s")).toBeVisible();
});

async function openFrenchAuthenticationSettings() {
  const clerk = context.mocks.clerk();
  await setupPage({
    context,
    path: "/agents?settings=preference",
    locale: "fr-FR",
  });
  await expect(
    screen.findByRole("heading", { name: "Préférences" }),
  ).resolves.toBeInTheDocument();
  // Clerk takes `localization` only as a global option, so the app-level
  // provider is what carries it to components opened outside the auth route.
  expect(clerkProviderLocalization()).toBe("S'inscrire");
  return clerk;
}

test("Authentication copy follows the selected language after switching", async () => {
  const clerk = await openFrenchAuthenticationSettings();
  await selectLanguage("Langue", "English");
  await expect(
    screen.findByRole("heading", { name: "Preference" }),
  ).resolves.toBeInTheDocument();
  expect(clerkProviderLocalization()).toBe("Sign up");
  expect(clerk.localizationRequests).toStrictEqual(["fr-FR"]);
});

test("Switching back reuses the previously loaded authentication language", async () => {
  const clerk = await openFrenchAuthenticationSettings();
  await selectLanguage("Langue", "English");
  await expect(
    screen.findByRole("heading", { name: "Preference" }),
  ).resolves.toBeInTheDocument();
  await selectLanguage("Language", "Français");
  await expect(
    screen.findByRole("heading", { name: "Préférences" }),
  ).resolves.toBeInTheDocument();
  expect(clerkProviderLocalization()).toBe("S'inscrire");

  // Returning to French reuses the cached resource instead of downloading it
  // again, and English never downloads because it ships as the default.
  expect(clerk.localizationRequests).toStrictEqual(["fr-FR"]);
});

test("An unsupported language falls back and repairs the workspace cache", async () => {
  context.mocks.browser.language("nl-NL");
  const updates: unknown[] = [];
  const initialPreferences = preferences({ locale: null });
  context.mocks.data.userPreferences(initialPreferences);
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    updates.push(body);
    return respond(200, { ...initialPreferences, ...body });
  });

  await setupPage({ context, path: "/settings" });

  await waitForSettings();
  await waitFor(() => {
    expect(updates).toContainEqual({ locale: DEFAULT_LOCALE });
  });
  expect(document.documentElement).toHaveAttribute("lang", DEFAULT_LOCALE);
  expect(screen.getByText("Language")).toBeVisible();
});
