import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { proactiveLearningContract } from "@okouai/api-contracts/contracts/proactive-nightly";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { updateUserPreference$ } from "../../../signals/okou-page/settings/user-preferences.ts";

const context = testContext();

function initialPreferences(): UserPreferencesResponse {
  return {
    timezone: "Etc/UTC",
    locale: "en-US",
    supportedLocales: ["en-US", "pt-BR"],
    pinnedAgentIds: [],
    sendMode: "cmd-enter",
    cloudBrowserEnabledByDefault: false,
    chatResourcesEnabledByDefault: true,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
}

function getSendModeButton(name: string): HTMLElement {
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
  let reads = 0;
  const sendModeWrite = context.mocks.deferred<void>();
  const cloudBrowserWrite = context.mocks.deferred<void>();
  const timezoneWrite = context.mocks.deferred<void>();
  const releaseSendMode = context.mocks.deferred<void>();
  const releaseCloudBrowser = context.mocks.deferred<void>();
  const releaseTimezone = context.mocks.deferred<void>();
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    reads += 1;
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
    reads: () => {
      return reads;
    },
  };
}

test("saving send mode updates the setting from the write response", async () => {
  const saves = delayPreferenceSaves();
  await setupPage({ context, path: "/agents?settings=chat" });
  const browser = await screen.findByRole("switch", { name: "Cloud browser" });
  await waitFor(() => {
    expect(browser).toBeEnabled();
  });
  const readsBeforeSave = saves.reads();
  click(getSendModeButton("Enter"));
  await saves.sendModeWrite.promise;

  expect(getSendModeButton("Enter")).toBeDisabled();
  expect(getSendModeButton("⌘ Enter")).toHaveAttribute("aria-pressed", "true");
  expect(browser).not.toBeChecked();
  expect(browser).toBeEnabled();

  saves.releaseSendMode.resolve();
  await waitFor(() => {
    expect(getSendModeButton("Enter")).toBeEnabled();
    expect(getSendModeButton("Enter")).toHaveAttribute("aria-pressed", "true");
  });
  expect(browser).not.toBeChecked();
  expect(saves.reads()).toBe(readsBeforeSave);
});

test("overlapping saves preserve each confirmed preference without another read", async () => {
  const saves = delayPreferenceSaves();
  await setupPage({ context, path: "/agents?settings=chat" });
  const browser = await screen.findByRole("switch", { name: "Cloud browser" });
  await waitFor(() => {
    expect(browser).toBeEnabled();
  });
  const readsBeforeSave = saves.reads();
  click(browser);
  await saves.cloudBrowserWrite.promise;

  expect(browser).toHaveAttribute("aria-disabled", "true");
  expect(browser).not.toBeChecked();
  expect(getSendModeButton("⌘ Enter")).toHaveAttribute("aria-pressed", "true");
  expect(getSendModeButton("Enter")).toBeEnabled();
  click(getSendModeButton("Enter"));
  await saves.sendModeWrite.promise;

  saves.releaseSendMode.resolve();
  await waitFor(() => {
    expect(getSendModeButton("Enter")).toHaveAttribute("aria-pressed", "true");
  });
  expect(browser).not.toBeChecked();

  saves.releaseCloudBrowser.resolve();
  await waitFor(() => {
    expect(browser).toBeChecked();
    expect(browser).toBeEnabled();
  });
  expect(getSendModeButton("Enter")).toHaveAttribute("aria-pressed", "true");
  expect(saves.reads()).toBe(readsBeforeSave);
});

test("overlapping saves to one preference read back the committed value", async () => {
  let stored = initialPreferences();
  let reads = 0;
  const firstCommitted = context.mocks.deferred<void>();
  const releaseFirstResponse = context.mocks.deferred<void>();
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    reads += 1;
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
      }
      return respond(200, saved);
    },
  );
  await setupPage({ context, path: "/agents?settings=chat" });
  const browser = await screen.findByRole("switch", { name: "Cloud browser" });
  await waitFor(() => {
    expect(browser).toBeEnabled();
    expect(getSendModeButton("⌘ Enter")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  const readsBeforeSave = reads;
  click(getSendModeButton("Enter"));
  await firstCommitted.promise;

  await context.store.set(
    updateUserPreference$,
    { sendMode: "cmd-enter" },
    context.signal,
  );
  expect(reads).toBe(readsBeforeSave);

  releaseFirstResponse.resolve();
  await waitFor(() => {
    expect(reads).toBe(readsBeforeSave + 1);
    expect(getSendModeButton("Enter")).toBeEnabled();
    expect(getSendModeButton("⌘ Enter")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.each([false, true])(
  "saving Learning (initially %s) keeps enabled Suggestions unchanged during refresh",
  async (initialEnabled) => {
    let saved = false;
    let enabled = initialEnabled;
    const refreshing = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
      return respond(200, {
        enabled: true,
        status: "enabled",
        unavailableReason: null,
      });
    });
    context.mocks.api(
      proactiveLearningContract.get,
      async ({ respond, withSignal }) => {
        if (saved) {
          refreshing.resolve();
          await withSignal(release.promise);
        }
        return respond(200, {
          enabled,
          status: enabled ? "enabled" : "paused",
          unavailableReason: null,
        });
      },
    );
    context.mocks.api(proactiveLearningContract.update, ({ body, respond }) => {
      saved = true;
      enabled = body.enabled;
      return respond(200, {
        enabled,
        status: enabled ? "enabled" : "paused",
        unavailableReason: null,
      });
    });
    await setupPage({
      context,
      path: "/agents?settings=preference",
      featureSwitches: {
        [FeatureSwitchKey.AgentSuggestion]: true,
        [FeatureSwitchKey.ProactiveLearning]: true,
      },
    });
    const suggestions = await screen.findByRole("switch", {
      name: "Suggestions",
    });
    const learning = screen.getByRole("switch", { name: "Learning" });
    await waitFor(() => {
      expect(suggestions).toBeChecked();
      expect(learning).toBeEnabled();
      expect(learning).toHaveAttribute("aria-checked", String(initialEnabled));
    });
    click(learning);
    await refreshing.promise;
    expect(learning).toHaveAttribute("aria-disabled", "true");
    expect(learning).toHaveAttribute("aria-checked", String(initialEnabled));
    expect(suggestions).toBeChecked();
    expect(suggestions).toBeEnabled();
    release.resolve();
    await waitFor(() => {
      expect(learning).toHaveAttribute("aria-checked", String(!initialEnabled));
      expect(learning).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(suggestions).toBeChecked();
  },
);

test.each(["reopening Settings", "returning to Preference"])(
  "%s refreshes a Learning preference changed elsewhere",
  async (entry) => {
    let enabled = false;
    context.mocks.api(proactiveLearningContract.get, ({ respond }) => {
      return respond(200, {
        enabled,
        status: enabled ? "enabled" : "paused",
        unavailableReason: null,
      });
    });
    await setupPage({
      context,
      path: "/agents?settings=preference",
      featureSwitches: { [FeatureSwitchKey.ProactiveLearning]: true },
    });
    const learning = await screen.findByRole("switch", {
      name: "Learning",
    });
    await waitFor(() => {
      expect(learning).toBeEnabled();
      expect(learning).not.toBeChecked();
    });
    const settings = screen.getByRole("dialog", { name: "Settings" });
    function selectSection(name: string) {
      const button = queryAllByRoleFast("button", settings).find((element) => {
        return element.textContent?.trim() === name;
      });
      if (!button) {
        throw new Error(`Settings section not found: ${name}`);
      }
      click(button);
    }
    if (entry === "reopening Settings") {
      click(within(settings).getByLabelText("Close", { selector: "button" }));
    } else {
      selectSection("Chat");
      await within(settings).findByRole("switch", { name: "Cloud browser" });
    }
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBe(
        entry === "reopening Settings" ? null : settings,
      );
    });

    enabled = true;
    if (entry === "reopening Settings") {
      const rail = await screen.findByTestId("labeled-nav-rail");
      click(within(rail).getByLabelText("Test User"));
      click(within(await screen.findByRole("menu")).getByText("Settings"));
    } else {
      selectSection("Preference");
    }
    const reopened = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => {
      const refreshed = within(reopened).getByRole("switch", {
        name: "Learning",
      });
      expect(refreshed).toBeEnabled();
      expect(refreshed).toBeChecked();
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
  await setupPage({ context, path: "/agents?settings=preference" });
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
  { name: "Suggestions", contract: proactiveSuggestionsContract },
  { name: "Learning", contract: proactiveLearningContract },
])(
  "keeps $name pending until its saved preference has been read back",
  async ({ name, contract }) => {
    let saved = false;
    const refreshing = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(contract.get, async ({ respond, withSignal }) => {
      if (saved) {
        refreshing.resolve();
        await withSignal(release.promise);
      }
      return respond(200, {
        enabled: !saved,
        status: saved ? "paused" : "enabled",
        unavailableReason: null,
      });
    });
    context.mocks.api(contract.update, ({ body, respond }) => {
      saved = true;
      return respond(200, {
        enabled: body.enabled,
        status: "paused",
        unavailableReason: null,
      });
    });
    await setupPage({
      context,
      path: "/agents?settings=preference",
      featureSwitches: {
        [FeatureSwitchKey.AgentSuggestion]: true,
        [FeatureSwitchKey.ProactiveLearning]: true,
      },
    });
    const toggle = await screen.findByRole("switch", { name });
    await waitFor(() => {
      expect(toggle).toBeChecked();
      expect(toggle).toBeEnabled();
    });
    toggle.focus();
    await userEvent.keyboard(" ");
    await refreshing.promise;
    const independent = screen.getByRole("switch", {
      name: name === "Learning" ? "Morning brief" : "Learning",
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
  },
);

test("a Morning brief refresh failure still reports the error and disables the switch", async () => {
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
  await setupPage({ context, path: "/agents?settings=preference" });
  const card = await screen.findByTestId("morning-brief-preference");
  const toggle = within(card).getByRole("switch", { name: "Morning brief" });
  await waitFor(() => {
    expect(toggle).toBeChecked();
  });
  click(toggle);
  await within(card).findByText(/could not be loaded or updated/u);
  expect(toggle).toHaveAttribute("aria-disabled", "true");
});
