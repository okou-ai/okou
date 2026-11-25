import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const title = "Default presentation format";
const auth = Object.freeze({
  user: Object.freeze({
    id: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
    fullName: "Presentation Owner",
    email: "presentation-owner@example.test",
  }),
});

function mockPreferences(
  presentationFormat: UserPreferencesResponse["presentationFormat"],
): UserPreferencesResponse {
  const preferences: UserPreferencesResponse = {
    timezone: "Etc/UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],
    sendMode: "cmd-enter",
    cloudBrowserEnabledByDefault: false,
    chatResourcesEnabledByDefault: false,
    presentationFormat,
    forYouCoverId: null,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
  context.mocks.data.userPreferences(preferences);
  return preferences;
}

async function openChatSettings(enabled = true, pageContext = context) {
  await setupPage({
    context: pageContext,
    path: "/?settings=chat",
    auth,
    featureSwitches: {
      [FeatureSwitchKey.PresentationOutputFormat]: enabled,
    },
  });
  return await screen.findByRole("dialog", { name: "Settings" });
}

function settingsButton(settings: HTMLElement, name: string): HTMLElement {
  const button = queryAllByRoleFast("button", settings).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!button) {
    throw new Error(`Expected Settings button ${name}`);
  }
  return button;
}

test("Chat settings keeps the presentation format entry behind its existing gate", async () => {
  mockPreferences("pptx");
  const settings = await openChatSettings(false);
  const browser = await within(settings).findByRole("switch", {
    name: "Cloud browser",
  });
  await waitFor(() => {
    expect(browser).toBeEnabled();
  });
  expect(
    within(settings).queryByRole("combobox", { name: title }),
  ).not.toBeInTheDocument();
});

test("opening Chat from Preference shows confirmed null as Not set without choosing a format", async () => {
  const preferences = mockPreferences(null);
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    // Loading or opening the control must not create a presentation default.
    expect(body).not.toHaveProperty("presentationFormat");
    return respond(200, preferences);
  });
  await setupPage({
    context,
    path: "/?settings=preference",
    auth,
    featureSwitches: { [FeatureSwitchKey.PresentationOutputFormat]: true },
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await within(settings).findByRole("combobox", { name: "Time zone" });
  click(settingsButton(settings, "Chat"));
  const select = await within(settings).findByRole("combobox", { name: title });
  await waitFor(() => {
    expect(select).toBeEnabled();
    expect(select).toHaveTextContent("Not set");
  });
  expect(
    within(settings).getByText("Choose the default for new presentations"),
  ).toBeInTheDocument();

  click(select);
  const html = await screen.findByRole("option", { name: "HTML" });
  expect(html).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("option", { name: "PPTX" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  expect(select).toHaveTextContent("Not set");
});

test.each(["html", "pptx"] as const)(
  "selecting %s saves only that format immediately and a fresh page reads the confirmed server value",
  async (format) => {
    let stored = mockPreferences(null);
    const requested = context.mocks.deferred<UpdateUserPreferencesRequest>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, stored);
    });
    context.mocks.api(
      userPreferencesContract.update,
      async ({ body, respond, withSignal }) => {
        requested.resolve(body);
        await withSignal(release.promise);
        stored = { ...stored, ...body };
        return respond(200, stored);
      },
    );
    const originalPage = createTestRuntime(context);
    const settings = await openChatSettings(true, originalPage);
    const select = await within(settings).findByRole("combobox", {
      name: title,
    });
    await waitFor(() => {
      expect(select).toBeEnabled();
      expect(select).toHaveTextContent("Not set");
    });

    click(select);
    click(await screen.findByRole("option", { name: format.toUpperCase() }));
    await expect(requested.promise).resolves.toStrictEqual({
      presentationFormat: format,
    });
    await waitFor(() => {
      expect(select).toBeDisabled();
    });
    expect(select).toHaveTextContent("Not set");
    expect(
      within(settings).getByRole("switch", { name: "Cloud browser" }),
    ).toBeEnabled();

    release.resolve();
    await waitFor(() => {
      expect(select).toBeEnabled();
      expect(select).toHaveTextContent(format.toUpperCase());
    });

    await act(() => {
      originalPage.dispose();
    });
    cleanup();
    vi.mocked(window.history.pushState).mockRestore();
    vi.mocked(window.history.replaceState).mockRestore();
    vi.mocked(window.history.back).mockRestore();
    vi.mocked(window.history.forward).mockRestore();
    const freshPage = createTestRuntime(context);
    const reopened = await openChatSettings(true, freshPage);
    const persisted = await within(reopened).findByRole("combobox", {
      name: title,
    });
    await waitFor(() => {
      expect(persisted).toBeEnabled();
      expect(persisted).toHaveTextContent(format.toUpperCase());
    });
  },
);

test.each([null, "html"] as const)(
  "a failed save keeps the prior %s preference and announces an accessible error",
  async (prior) => {
    mockPreferences(prior);
    context.mocks.api(userPreferencesContract.update, ({ respond }) => {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Preference save failed",
        },
      });
    });
    const settings = await openChatSettings();
    const select = await within(settings).findByRole("combobox", {
      name: title,
    });
    const previousLabel = prior === null ? "Not set" : prior.toUpperCase();
    await waitFor(() => {
      expect(select).toBeEnabled();
      expect(select).toHaveTextContent(previousLabel);
    });

    click(select);
    click(await screen.findByRole("option", { name: "PPTX" }));
    const error = await within(settings).findByRole("alert");
    expect(error).toHaveTextContent(
      "Couldn't save the default format. Try again.",
    );
    expect(select).toBeEnabled();
    expect(select).toHaveTextContent(previousLabel);
  },
);

test("an enabled but unavailable server field is disabled rather than shown as an HTML or unset default", async () => {
  // The response contract permits an older server to omit this enabled field.
  mockPreferences(undefined);
  const settings = await openChatSettings();
  const select = await within(settings).findByRole("combobox", { name: title });
  await waitFor(() => {
    expect(select).toHaveTextContent("Unavailable");
  });
  expect(select).toBeDisabled();
  expect(select).not.toHaveTextContent("Not set");
  expect(select).not.toHaveTextContent("HTML");
});
