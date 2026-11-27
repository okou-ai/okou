import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const formatKey = FeatureSwitchKey.PresentationOutputFormat;

function workspace() {
  let switches: Partial<Record<FeatureSwitchKey, boolean>> = {
    [FeatureSwitchKey.Lab]: true,
    [formatKey]: true,
  };
  const preferences: UserPreferencesResponse = {
    timezone: "UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: false,
    forYouCoverId: null,
    theme: "system",
    colorTheme: null,
    presentationFormat: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches, effectiveSwitches: switches });
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    switches = { ...switches, ...body.switches };
    return respond(200, { switches, effectiveSwitches: switches });
  });
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, {
      ...preferences,
      presentationFormat: switches[formatKey]
        ? preferences.presentationFormat
        : undefined,
    });
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    Object.assign(preferences, body);
    return respond(200, { ...preferences });
  });
  return { preferences };
}

async function openChatSettings() {
  click(await findAction("button", "Test User"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings", { exact: true }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  click(await findAction("button", "Chat", dialog));
  await within(dialog).findByText("Cloud browser", { exact: true });
  return dialog;
}

async function closeSettings() {
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
}

async function setFormatEnabled(enabled: boolean) {
  const control = await screen.findByRole("switch", { name: formatKey });
  await waitFor(() => {
    expect(control).toBeEnabled();
    expect(control).not.toHaveAttribute("aria-disabled", "true");
  });
  click(control);
  await waitFor(() => {
    expect(control).toHaveAttribute("aria-checked", String(enabled));
    expect(control).toBeEnabled();
    expect(control).not.toHaveAttribute("aria-disabled", "true");
  });
}

test("Re-enabling the Lab option reads the saved member format instead of retaining an earlier confirmation", async () => {
  const { preferences } = workspace();
  await setupPage({ context, path: "/_/lab?settings=chat" });
  const group = await screen.findByRole("group", {
    name: "Default presentation format",
  });
  const html = getAction("button", "Web slides", group);
  await waitFor(() => {
    expect(html).toBeEnabled();
  });
  click(html);
  await waitFor(() => {
    expect(html).toHaveAttribute("aria-pressed", "true");
  });
  await closeSettings();

  await setFormatEnabled(false);
  const disabledSettings = await openChatSettings();
  expect(
    within(disabledSettings).queryByRole("group", {
      name: "Default presentation format",
    }),
  ).not.toBeInTheDocument();
  expect(getAction("button", "Enter", disabledSettings)).toBeEnabled();
  await closeSettings();

  preferences.presentationFormat = "pptx";
  await setFormatEnabled(true);
  const settings = await openChatSettings();
  const refreshed = await within(settings).findByRole("group", {
    name: "Default presentation format",
  });
  await waitFor(() => {
    expect(getAction("button", "PowerPoint", refreshed)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(getAction("button", "PowerPoint", refreshed)).toBeEnabled();
  });
  expect(getAction("button", "Web slides", refreshed)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("Preferences saved across a Lab refresh converge after all pending writes finish", async () => {
  const { preferences } = workspace();
  preferences.presentationFormat = "html";
  const formatStarted = context.mocks.deferred<void>();
  const sendModeStarted = context.mocks.deferred<void>();
  const releaseFormat = context.mocks.deferred<void>();
  const releaseSendMode = context.mocks.deferred<void>();
  const formatCommitted = context.mocks.deferred<void>();
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond }) => {
      const confirmation = { ...preferences, ...body };
      if (body.presentationFormat !== undefined) {
        formatStarted.resolve();
        await releaseFormat.promise;
        preferences.presentationFormat = body.presentationFormat;
        formatCommitted.resolve();
      }
      if (body.sendMode !== undefined) {
        sendModeStarted.resolve();
        await releaseSendMode.promise;
        preferences.sendMode = body.sendMode;
      }
      return respond(200, confirmation);
    },
  );

  try {
    await setupPage({ context, path: "/_/lab?settings=chat" });
    const group = await screen.findByRole("group", {
      name: "Default presentation format",
    });
    const pptx = getAction("button", "PowerPoint", group);
    await waitFor(() => {
      expect(pptx).toBeEnabled();
    });
    click(pptx);
    await formatStarted.promise;
    const sendMode = getAction("button", "⌘ Enter");
    click(sendMode);
    await sendModeStarted.promise;
    await closeSettings();

    await setFormatEnabled(false);
    await setFormatEnabled(true);
    const settings = await openChatSettings();
    const refreshed = await within(settings).findByRole("group", {
      name: "Default presentation format",
    });
    await waitFor(() => {
      expect(getAction("button", "Web slides", refreshed)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    releaseFormat.resolve();
    await formatCommitted.promise;
    releaseSendMode.resolve();
    await waitFor(() => {
      expect(getAction("button", "PowerPoint", refreshed)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(getAction("button", "PowerPoint", refreshed)).toBeEnabled();
      expect(getAction("button", "⌘ Enter", settings)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  } finally {
    if (!releaseFormat.settled()) {
      releaseFormat.resolve();
    }
    if (!releaseSendMode.settled()) {
      releaseSendMode.resolve();
    }
  }
});
