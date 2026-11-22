import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
function response(enabled: boolean) {
  return {
    enabled,
    status: enabled ? ("enabled" as const) : ("paused" as const),
    unavailableReason: null,
  };
}
function settingsData(brief: boolean, suggestions: boolean) {
  const state = { brief, suggestions };
  const hold = context.mocks.deferred<void>(),
    started = context.mocks.deferred<void>();
  context.mocks.api(feedContract.sources, ({ respond }) => {
    return respond(200, {
      suggestions: state.suggestions,
      whatsNew: true,
      offers: true,
      systemUpdates: true,
    });
  });
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return respond(200, response(state.brief));
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, response(state.suggestions));
  });
  context.mocks.api(
    morningBriefPreferenceContract.update,
    ({ respond, body }) => {
      state.brief = body.enabled;
      return respond(200, response(body.enabled));
    },
  );
  context.mocks.api(
    proactiveSuggestionsContract.updateWithFeed,
    async ({ respond, body }) => {
      if (!started.settled()) {
        started.resolve();
      }
      await hold.promise;
      state.suggestions = body.enabled;
      return respond(200, response(body.enabled));
    },
  );
  return { state, hold, started };
}
async function settings(section: string, myOkou = true) {
  await setupPage({
    context,
    path: "/?settings=" + section,
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: myOkou },
  });
}
const toggle = (name: string) => {
  return screen.findByRole("switch", { name });
};
async function enabled(control: HTMLElement, value: boolean) {
  await waitFor(() => {
    expect(control).toHaveAttribute("aria-checked", String(value));
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(control).toBeEnabled();
  });
}
test("settings-refresh-state-003 Morning brief remains usable while a Suggestions save is held", async () => {
  const { hold, started } = settingsData(false, true);
  try {
    await settings("my-okou");
    const suggestions = await toggle("Suggestions"),
      brief = await toggle("Morning brief");
    await enabled(suggestions, true);
    await enabled(brief, false);
    click(suggestions);
    await started.promise;
    expect(suggestions).toBeChecked();
    expect(suggestions).toHaveAttribute("aria-disabled", "true");
    click(brief);
    await enabled(brief, true);
    hold.resolve();
    await enabled(suggestions, false);
    await enabled(brief, true);
  } finally {
    if (!hold.settled()) {
      hold.resolve();
    }
  }
});
test("settings-refresh-state-005 Reopening My Okou displays a Suggestions change made outside this page", async () => {
  const { state, hold } = settingsData(true, true);
  hold.resolve();
  await settings("my-okou");
  const suggestions = await toggle("Suggestions");
  await enabled(suggestions, true);
  click(suggestions);
  await enabled(suggestions, false);
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(suggestions).not.toBeInTheDocument();
  });
  state.suggestions = true;
  context.mocks.ably.triggerOnChannel(
    "user-org:test-user-123:org_default",
    "agentSuggestionsChanged",
    null,
  );
  click(await findFastControl("button", "Test User"));
  const menu = await screen.findByRole("menu");
  click(await within(menu).findByText("Settings"));
  click(await findFastControl("button", "My Okou"));
  await waitFor(() => {
    return expect(window.location.search).toContain("settings=my-okou");
  });
  await waitFor(() => {
    const current = screen.getByRole("switch", { name: "Suggestions" });
    expect(current).toBeChecked();
    expect(current).not.toHaveAttribute("aria-disabled", "true");
  });
});
test("settings-refresh-state-008 Saving Morning brief leaves Suggestions usable and publishes the confirmation independently of rereads", async () => {
  const { hold: savedSuggestions } = settingsData(true, false);
  savedSuggestions.resolve();
  const held = context.mocks.deferred<void>(),
    inFlight = context.mocks.deferred<void>(),
    reread = context.mocks.deferred<void>();
  let written = false;
  context.mocks.api(morningBriefPreferenceContract.get, async ({ respond }) => {
    if (written) {
      await reread.promise;
    }
    return respond(200, response(true));
  });
  context.mocks.api(
    morningBriefPreferenceContract.update,
    async ({ body, respond }) => {
      inFlight.resolve();
      await held.promise;
      written = true;
      return respond(200, response(body.enabled));
    },
  );
  try {
    await settings("my-okou");
    const brief = await toggle("Morning brief"),
      suggestions = await toggle("Suggestions");
    await enabled(brief, true);
    await enabled(suggestions, false);
    click(brief);
    await inFlight.promise;
    expect(brief).toHaveAttribute("aria-disabled", "true");
    expect(brief).toBeChecked();
    click(suggestions);
    await enabled(suggestions, true);
    held.resolve();
    await enabled(brief, false);
    await enabled(suggestions, true);
  } finally {
    if (!held.settled()) {
      held.resolve();
    }
    reread.resolve();
  }
});
function generalPreferences(): UserPreferencesResponse {
  return {
    timezone: "America/Los_Angeles",
    locale: "en-US",
    supportedLocales: ["en-US"],
    sendMode: "cmd-enter",
    cloudBrowserEnabledByDefault: false,
    chatResourcesEnabledByDefault: false,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
}
test("settings-refresh-state-007 Morning brief remains available throughout changing the account time zone to Eastern Time", async () => {
  const { hold } = settingsData(true, true);
  hold.resolve();
  const prefs = generalPreferences();
  const changed = context.mocks.deferred<void>(),
    received = context.mocks.deferred<void>();
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, prefs);
  });
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond }) => {
      if (body.timezone) {
        received.resolve();
        await changed.promise;
        prefs.timezone = body.timezone;
      }
      return respond(200, prefs);
    },
  );
  try {
    await settings("preference", false);
    const brief = await toggle("Morning brief");
    await enabled(brief, true);
    const select = await waitFor(() => {
      const choice = screen.getAllByRole("combobox").find((el) => {
        return el.textContent?.includes("Pacific");
      });
      expect(choice).toBeDefined();
      return choice!;
    });
    click(select);
    click(await screen.findByRole("option", { name: /Eastern Time \(ET\)/ }));
    await received.promise;
    await enabled(brief, true);
    changed.resolve();
    await waitFor(() => {
      return expect(select).toHaveTextContent("Eastern Time (ET)");
    });
    await enabled(brief, true);
  } finally {
    if (!changed.settled()) {
      changed.resolve();
    }
  }
});
