import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { proactiveJobsContract } from "@okouai/api-contracts/contracts/proactive-jobs";
import { proactiveLearningContract } from "@okouai/api-contracts/contracts/proactive-nightly";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

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

function delayPreferenceRefresh() {
  let saved = false;
  let value: UserPreferencesResponse = {
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
  const refreshing = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    userPreferencesContract.get,
    async ({ respond, withSignal }) => {
      if (saved) {
        refreshing.resolve();
        await withSignal(release.promise);
      }
      return respond(200, value);
    },
  );
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    value = { ...value, ...body };
    saved = true;
    return respond(200, value);
  });
  return { refreshing, release };
}

test("saving send mode keeps a disabled cloud browser preference unchanged during refresh", async () => {
  const { refreshing, release } = delayPreferenceRefresh();
  await setupPage({ context, path: "/agents?settings=chat" });
  const browser = await screen.findByRole("switch", { name: "Cloud browser" });
  await waitFor(() => {
    expect(browser).toBeEnabled();
  });
  expect(browser).not.toBeChecked();
  click(getSendModeButton("Enter"));
  await refreshing.promise;
  await waitFor(() => {
    expect(getSendModeButton("Enter")).toBeDisabled();
  });
  expect(getSendModeButton("⌘ Enter")).toHaveAttribute("aria-pressed", "true");
  expect(browser).not.toBeChecked();
  expect(browser).toBeEnabled();

  release.resolve();
  await waitFor(() => {
    expect(getSendModeButton("Enter")).toBeEnabled();
    expect(getSendModeButton("Enter")).toHaveAttribute("aria-pressed", "true");
  });
  expect(browser).not.toBeChecked();
});

test("saving cloud browser keeps the selected send mode unchanged during refresh", async () => {
  const { refreshing, release } = delayPreferenceRefresh();
  await setupPage({ context, path: "/agents?settings=chat" });
  const browser = await screen.findByRole("switch", { name: "Cloud browser" });
  await waitFor(() => {
    expect(browser).toBeEnabled();
  });
  expect(getSendModeButton("⌘ Enter")).toHaveAttribute("aria-pressed", "true");
  click(browser);
  await refreshing.promise;
  await waitFor(() => {
    expect(browser).toHaveAttribute("aria-disabled", "true");
  });
  expect(browser).not.toBeChecked();
  expect(getSendModeButton("⌘ Enter")).toHaveAttribute("aria-pressed", "true");
  expect(getSendModeButton("⌘ Enter")).toBeEnabled();

  release.resolve();
  await waitFor(() => {
    expect(browser).toBeChecked();
    expect(browser).toBeEnabled();
  });
  expect(getSendModeButton("⌘ Enter")).toHaveAttribute("aria-pressed", "true");
});

test.each([false, true])(
  "saving Planning and action (initially %s) keeps enabled Suggestions unchanged during refresh",
  async (initialEnabled) => {
    let saved = false;
    let enabled = initialEnabled;
    const refreshing = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(
      proactiveSuggestionsContract.get,
      async ({ respond, withSignal }) => {
        if (saved) {
          refreshing.resolve();
          await withSignal(release.promise);
        }
        return respond(200, {
          enabled: true,
          status: "enabled",
          unavailableReason: null,
        });
      },
    );
    context.mocks.api(proactiveJobsContract.get, ({ respond }) => {
      return respond(200, {
        enabled,
        status: enabled ? "enabled" : "paused",
        unavailableReason: null,
      });
    });
    context.mocks.api(proactiveJobsContract.update, ({ body, respond }) => {
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
        [FeatureSwitchKey.ProactiveAgent]: true,
      },
    });
    const suggestions = await screen.findByRole("switch", {
      name: "Suggestions",
    });
    const planning = screen.getByRole("switch", { name: "Planning & action" });
    await waitFor(() => {
      expect(suggestions).toBeChecked();
      expect(planning).toBeEnabled();
      expect(planning).toHaveAttribute("aria-checked", String(initialEnabled));
    });
    click(planning);
    await refreshing.promise;
    await waitFor(() => {
      expect(planning).toHaveAttribute("aria-checked", String(!initialEnabled));
      expect(planning).toBeEnabled();
    });
    expect(suggestions).toBeChecked();
    expect(suggestions).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Learning" })).not.toBeChecked();
    release.resolve();
  },
);

test.each(["reopening Settings", "returning to Preference"])(
  "%s refreshes a Planning preference changed elsewhere",
  async (entry) => {
    let enabled = false;
    context.mocks.api(proactiveJobsContract.get, ({ respond }) => {
      return respond(200, {
        enabled,
        status: enabled ? "enabled" : "paused",
        unavailableReason: null,
      });
    });
    await setupPage({
      context,
      path: "/agents?settings=preference",
      featureSwitches: { [FeatureSwitchKey.ProactiveAgent]: true },
    });
    const planning = await screen.findByRole("switch", {
      name: "Planning & action",
    });
    await waitFor(() => {
      expect(planning).toBeEnabled();
      expect(planning).not.toBeChecked();
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
        name: "Planning & action",
      });
      expect(refreshed).toBeEnabled();
      expect(refreshed).toBeChecked();
    });
  },
);

test("saving time zone keeps enabled Morning brief unchanged during refresh", async () => {
  const { refreshing, release } = delayPreferenceRefresh();
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
  await refreshing.promise;
  await waitFor(() => {
    expect(timezone).toBeEnabled();
  });
  expect(morning).toBeChecked();
  expect(morning).toBeEnabled();

  release.resolve();
  await waitFor(() => {
    expect(timezone).toHaveTextContent("Eastern Time (ET)");
  });
  expect(morning).toBeChecked();
});

test.each([
  { name: "Morning brief", contract: morningBriefPreferenceContract },
  { name: "Suggestions", contract: proactiveSuggestionsContract },
  { name: "Learning", contract: proactiveLearningContract },
  { name: "Planning & action", contract: proactiveJobsContract },
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
        [FeatureSwitchKey.ProactiveAgent]: true,
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
