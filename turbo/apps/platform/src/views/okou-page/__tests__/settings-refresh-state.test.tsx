import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function initialPreferences(): UserPreferencesResponse {
  return {
    timezone: "Etc/UTC",
    locale: "en-US",
    supportedLocales: ["en-US", "pt-BR"],
    sendMode: "cmd-enter",
    cloudBrowserEnabledByDefault: false,
    chatResourcesEnabledByDefault: true,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
}

function getSettingsButton(name: string): HTMLElement {
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const button = queryAllByRoleFast("button", dialog).find((element) => {
    return element.textContent?.trim() === name;
  });
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function delayPreferenceSaves() {
  const original = initialPreferences();
  const sendModeWrite = context.mocks.deferred<void>();
  const cloudBrowserWrite = context.mocks.deferred<void>();
  const timezoneWrite = context.mocks.deferred<void>();
  const releaseSendMode = context.mocks.deferred<void>();
  const releaseCloudBrowser = context.mocks.deferred<void>();
  const releaseTimezone = context.mocks.deferred<void>();
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, original);
  });
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond, withSignal }) => {
      if (body.sendMode !== undefined) {
        sendModeWrite.resolve();
        await withSignal(releaseSendMode.promise);
      } else if (body.cloudBrowserEnabledByDefault !== undefined) {
        cloudBrowserWrite.resolve();
        await withSignal(releaseCloudBrowser.promise);
      } else {
        timezoneWrite.resolve();
        await withSignal(releaseTimezone.promise);
      }
      // Each response includes the pre-write value of the other preference.
      return respond(200, { ...original, ...body });
    },
  );
  return {
    sendModeWrite,
    cloudBrowserWrite,
    timezoneWrite,
    releaseSendMode,
    releaseCloudBrowser,
    releaseTimezone,
  };
}

test("saving send mode updates the setting from the write response", async () => {
  const saves = delayPreferenceSaves();
  await setupPage({ context, path: "/?settings=chat" });
  const browser = await screen.findByRole("switch", { name: "Cloud browser" });
  await waitFor(() => {
    expect(browser).toBeEnabled();
  });
  click(getSettingsButton("Enter"));
  await saves.sendModeWrite.promise;

  expect(getSettingsButton("Enter")).toBeDisabled();
  expect(getSettingsButton("⌘ Enter")).toHaveAttribute("aria-pressed", "true");
  expect(browser).not.toBeChecked();
  expect(browser).toBeEnabled();

  saves.releaseSendMode.resolve();
  await waitFor(() => {
    expect(getSettingsButton("Enter")).toBeEnabled();
    expect(getSettingsButton("Enter")).toHaveAttribute("aria-pressed", "true");
  });
  expect(browser).not.toBeChecked();
});

test("overlapping saves preserve each confirmed preference", async () => {
  const saves = delayPreferenceSaves();
  await setupPage({ context, path: "/?settings=chat" });
  const browser = await screen.findByRole("switch", { name: "Cloud browser" });
  await waitFor(() => {
    expect(browser).toBeEnabled();
  });
  click(browser);
  await saves.cloudBrowserWrite.promise;

  expect(browser).toHaveAttribute("aria-disabled", "true");
  expect(browser).not.toBeChecked();
  expect(getSettingsButton("⌘ Enter")).toHaveAttribute("aria-pressed", "true");
  expect(getSettingsButton("Enter")).toBeEnabled();
  click(getSettingsButton("Enter"));
  await saves.sendModeWrite.promise;

  saves.releaseSendMode.resolve();
  await waitFor(() => {
    expect(getSettingsButton("Enter")).toHaveAttribute("aria-pressed", "true");
  });
  expect(browser).not.toBeChecked();

  saves.releaseCloudBrowser.resolve();
  await waitFor(() => {
    expect(browser).toBeChecked();
    expect(browser).toBeEnabled();
  });
  expect(getSettingsButton("Enter")).toHaveAttribute("aria-pressed", "true");
});

test("overlapping saves to one preference read back the committed value", async () => {
  let stored = initialPreferences();
  const firstCommitted = context.mocks.deferred<void>();
  const secondCommitted = context.mocks.deferred<void>();
  const releaseFirstResponse = context.mocks.deferred<void>();
  const readBack = context.mocks.deferred<void>();
  let readyToReadBack = false;
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    if (readyToReadBack) {
      readBack.resolve();
    }
    return respond(200, stored);
  });
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond, withSignal }) => {
      const saved = { ...stored, ...body };
      stored = saved;
      if (body.sendMode === "enter") {
        firstCommitted.resolve();
        await withSignal(releaseFirstResponse.promise);
      } else if (body.sendMode === "cmd-enter") {
        secondCommitted.resolve();
      }
      return respond(200, saved);
    },
  );
  await setupPage({ context, path: "/?settings=chat" });
  const browser = await screen.findByRole("switch", { name: "Cloud browser" });
  await waitFor(() => {
    expect(browser).toBeEnabled();
    expect(getSettingsButton("⌘ Enter")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  click(getSettingsButton("Enter"));
  await firstCommitted.promise;

  click(getSettingsButton("Preference"));
  await screen.findByRole("combobox", { name: "Time zone" });
  click(getSettingsButton("Chat"));
  await waitFor(() => {
    expect(getSettingsButton("⌘ Enter")).toBeEnabled();
  });
  click(getSettingsButton("⌘ Enter"));
  await secondCommitted.promise;
  await waitFor(() => {
    expect(getSettingsButton("⌘ Enter")).toBeEnabled();
  });

  readyToReadBack = true;
  releaseFirstResponse.resolve();
  await readBack.promise;
  await waitFor(() => {
    expect(getSettingsButton("Enter")).toBeEnabled();
    expect(getSettingsButton("⌘ Enter")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.each(["reopening Settings", "returning to My Okou"])(
  "%s refreshes a Suggestions preference changed elsewhere after a save",
  async (entry) => {
    let enabled = false;
    context.mocks.api(feedContract.sources, ({ respond }) => {
      return respond(200, {
        suggestions: enabled,
        whatsNew: true,
        offers: true,
        systemUpdates: true,
      });
    });
    context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
      return respond(200, {
        enabled,
        status: enabled ? "enabled" : "paused",
        unavailableReason: null,
      });
    });
    context.mocks.api(
      proactiveSuggestionsContract.updateWithFeed,
      ({ body, respond }) => {
        enabled = body.enabled;
        return respond(200, {
          enabled,
          status: enabled ? "enabled" : "paused",
          unavailableReason: null,
        });
      },
    );
    await setupPage({
      context,
      path: "/?settings=my-okou",
      featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
    });
    const suggestions = await screen.findByRole("switch", {
      name: "Suggestions",
    });
    await waitFor(() => {
      expect(suggestions).toBeEnabled();
      expect(suggestions).not.toBeChecked();
    });
    click(suggestions);
    await waitFor(() => {
      expect(suggestions).toBeChecked();
      expect(suggestions).toBeEnabled();
    });
    const settings = screen.getByRole("dialog", { name: "Settings" });
    if (entry === "reopening Settings") {
      click(within(settings).getByLabelText("Close", { selector: "button" }));
    } else {
      click(getSettingsButton("Chat"));
      await within(settings).findByRole("switch", { name: "Cloud browser" });
    }
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBe(
        entry === "reopening Settings" ? null : settings,
      );
    });

    enabled = false;
    if (entry === "reopening Settings") {
      const rail = await screen.findByTestId("labeled-nav-rail");
      click(within(rail).getByLabelText("Test User"));
      click(within(await screen.findByRole("menu")).getByText("Settings"));
    }
    const reopened = await screen.findByRole("dialog", { name: "Settings" });
    const navigation = within(reopened).getByRole("navigation");
    click(within(navigation).getByText("My Okou"));
    await waitFor(() => {
      const refreshed = within(reopened).getByRole("switch", {
        name: "Suggestions",
      });
      expect(refreshed).toBeEnabled();
      expect(refreshed).not.toBeChecked();
    });
  },
);

test("saving time zone keeps enabled Morning brief unchanged", async () => {
  const saves = delayPreferenceSaves();
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return respond(200, {
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
  });
  await setupPage({ context, path: "/?settings=preference" });
  const morning = await screen.findByRole("switch", { name: "Morning brief" });
  await waitFor(() => {
    expect(morning).toBeChecked();
  });
  const timezone = screen.getByRole("combobox", { name: "Time zone" });
  click(timezone);
  await screen.findByRole("option", { name: /Eastern Time \(ET\)$/u });
  await userEvent.keyboard("{Home}{ArrowDown}{Enter}");
  await saves.timezoneWrite.promise;
  await waitFor(() => {
    expect(timezone).toBeDisabled();
  });
  expect(morning).toBeChecked();
  expect(morning).toBeEnabled();

  saves.releaseTimezone.resolve();
  await waitFor(() => {
    expect(timezone).toHaveTextContent("Eastern Time (ET)");
    expect(timezone).toBeEnabled();
  });
  expect(morning).toBeChecked();
});

test.each([
  { name: "Morning brief", contract: morningBriefPreferenceContract },
  {
    name: "Suggestions",
    contract: {
      get: proactiveSuggestionsContract.get,
      update: proactiveSuggestionsContract.updateWithFeed,
    },
  },
])(
  "updates $name from the save response while leaving other preferences usable",
  async ({ name, contract }) => {
    let enabled = true;
    let reads = 0;
    const saving = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    let suggestionsEnabled = name === "Suggestions";
    context.mocks.api(feedContract.sources, ({ respond }) => {
      return respond(200, {
        suggestions: suggestionsEnabled,
        whatsNew: true,
        offers: true,
        systemUpdates: true,
      });
    });
    if (name === "Morning brief") {
      context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
        return respond(200, {
          enabled: suggestionsEnabled,
          status: suggestionsEnabled ? "enabled" : "paused",
          unavailableReason: null,
        });
      });
      context.mocks.api(
        proactiveSuggestionsContract.updateWithFeed,
        ({ body, respond }) => {
          suggestionsEnabled = body.enabled;
          return respond(200, {
            enabled: body.enabled,
            status: body.enabled ? "enabled" : "paused",
            unavailableReason: null,
          });
        },
      );
    }
    context.mocks.api(contract.get, ({ respond }) => {
      reads++;
      return respond(200, {
        enabled,
        status: enabled ? "enabled" : "paused",
        unavailableReason: null,
      });
    });
    context.mocks.api(
      contract.update,
      async ({ body, respond, withSignal }) => {
        saving.resolve();
        await withSignal(release.promise);
        enabled = body.enabled;
        if (name === "Suggestions") {
          suggestionsEnabled = body.enabled;
        }
        return respond(200, {
          enabled,
          status: enabled ? "enabled" : "paused",
          unavailableReason: null,
        });
      },
    );
    await setupPage({
      context,
      path: "/?settings=my-okou",
      featureSwitches: {
        [FeatureSwitchKey.AgentSuggestion]: true,
      },
    });
    const toggle = await screen.findByRole("switch", { name });
    await waitFor(() => {
      expect(toggle).toBeChecked();
      expect(toggle).toBeEnabled();
    });
    const initialReads = reads;
    toggle.focus();
    await userEvent.keyboard(" ");
    await saving.promise;
    const independent = screen.getByRole("switch", {
      name: name === "Suggestions" ? "Morning brief" : "Suggestions",
    });
    expect(independent).not.toBeChecked();
    expect(independent).toBeEnabled();
    click(independent);
    await waitFor(() => {
      expect(independent).toBeChecked();
      expect(independent).toBeEnabled();
    });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toBeChecked();

    release.resolve();
    await waitFor(() => {
      expect(toggle).not.toBeChecked();
      expect(toggle).toBeEnabled();
    });
    expect(reads - initialReads).toBe(name === "Morning brief" ? 0 : 1);
  },
);

test("a Morning brief refresh failure after returning to Preference reports the error and disables the switch", async () => {
  let saved = false;
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return saved
      ? respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Refresh failed" },
        })
      : respond(200, {
          enabled: true,
          status: "enabled",
          unavailableReason: null,
        });
  });
  context.mocks.api(
    morningBriefPreferenceContract.update,
    ({ body, respond }) => {
      saved = true;
      return respond(200, {
        enabled: body.enabled,
        status: "paused",
        unavailableReason: null,
      });
    },
  );
  await setupPage({ context, path: "/?settings=preference" });
  const card = await screen.findByTestId("morning-brief-preference");
  const toggle = within(card).getByRole("switch", { name: "Morning brief" });
  await waitFor(() => {
    expect(toggle).toBeChecked();
  });
  click(toggle);
  await waitFor(() => {
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
  });
  click(getSettingsButton("Chat"));
  await screen.findByRole("switch", { name: "Cloud browser" });
  click(getSettingsButton("Preference"));
  const reopened = await screen.findByTestId("morning-brief-preference");
  await within(reopened).findByText(/could not be loaded or updated/u);
  expect(
    within(reopened).getByRole("switch", { name: "Morning brief" }),
  ).toHaveAttribute("aria-disabled", "true");
});
