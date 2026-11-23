// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import entryCss from "../../css/index.css?inline";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  findAction,
} from "./connector-integrations-test-helpers.ts";
const context = testContext();
function workspace(
  theme: UserPreferencesResponse["theme"],
  colorTheme: UserPreferencesResponse["colorTheme"],
) {
  const writtenPalettes = new Set<string>();
  const prefs: UserPreferencesResponse = {
    timezone: "UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],

    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: false,
    forYouCoverId: null,
    theme,
    colorTheme,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, prefs);
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    if (body.colorTheme) {
      writtenPalettes.add(body.colorTheme);
    }
    Object.assign(prefs, body);
    return respond(200, prefs);
  });
  return { prefs, writtenPalettes };
}
test("preferences-page-004 a workspace without a custom palette saves Golden hour only when selected", async () => {
  const { prefs, writtenPalettes } = workspace(null, null);
  await setupPage({ context, path: "/preferences" });
  const initial = await findAction("button", "Default");
  expect(initial).toHaveAttribute("aria-pressed", "true");
  const root = document.documentElement;
  expect(root).not.toHaveAttribute("data-color-theme");
  expect(root).not.toHaveAttribute("data-gradient-color-themes");
  expect(prefs.colorTheme).toBeNull();
  expect(writtenPalettes).toStrictEqual(new Set());
  const choice = getAction("button", "Golden hour");
  click(choice);
  await waitFor(() => {
    return expect(prefs.colorTheme).toBe("golden-hour");
  });
  expect(writtenPalettes).toStrictEqual(new Set(["golden-hour"]));
  expect(root).toHaveAttribute("data-color-theme", "golden-hour");
  expect(choice).toHaveAttribute("aria-pressed", "true");
  expect(initial).toHaveAttribute("aria-pressed", "false");
});
test("preferences-page-007 saving Eastern Time restores Morning Brief while leaving its time zone control available", async () => {
  const { prefs } = workspace(null, null);
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    const ready = prefs.timezone === "America/New_York";
    return respond(200, {
      enabled: ready,
      status: ready ? "enabled" : "paused",
      unavailableReason: ready ? null : "missing-timezone",
    });
  });
  await setupPage({
    context,
    path: "/preferences",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: false },
  });
  await expect(
    screen.findByText("Set a valid time zone before enabling Morning Brief."),
  ).resolves.toBeVisible();
  const zone = screen.getByRole("combobox", { name: /time zone/i });
  expect(zone).toHaveTextContent("UTC");
  click(zone);
  click(await screen.findByRole("option", { name: / Eastern Time \(ET\)$/ }));
  await waitFor(() => {
    return expect(
      screen.getByRole("switch", { name: /morning brief/i }),
    ).toBeChecked();
  });
  expect(prefs.timezone).toBe("America/New_York");
  expect(zone).toHaveTextContent(/Eastern Time/);
  expect(zone).toBeEnabled();
  expect(
    screen.queryByText("Set a valid time zone before enabling Morning Brief."),
  ).not.toBeInTheDocument();
});

// APCA 0.0.98G-4g uses gamma 2.4 and different exponents for each polarity.
function paletteLuminance(hsl: string) {
  const parts = hsl.trim().split(/\s+/u).map(Number.parseFloat);
  const [hue, saturation, lightness] = parts;
  const light = lightness / 100;
  const amplitude = (saturation / 100) * Math.min(light, 1 - light);
  function channel(offset: number) {
    const k = (offset + hue / 30) % 12;
    return (light - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1))) ** 2.4;
  }
  const y =
    0.2126729 * channel(0) + 0.7151522 * channel(8) + 0.072175 * channel(4);
  return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
}

function apcaMagnitude(ink: number, fill: number) {
  const difference =
    ink < fill ? fill ** 0.56 - ink ** 0.57 : ink ** 0.62 - fill ** 0.65;
  const contrast = 1.14 * difference;
  return contrast < 0.1 ? 0 : 100 * (contrast - 0.027);
}

test.each([
  ["color-themes-001", "Golden hour", "golden-hour"],
  ["color-themes-002", "Citrus spark", "citrus-spark"],
])(
  "%s renders the stronger accessible label on both selected palette fills",
  async (_id, name, theme) => {
    workspace(null, null);
    const sheet = document.createElement("style");
    sheet.textContent = entryCss;
    document.head.append(sheet);
    try {
      await setupPage({ context, path: "/preferences" });
      click(await findAction("button", name));
      const root = document.documentElement;
      await waitFor(() => {
        return expect(root).toHaveAttribute("data-color-theme", theme);
      });
      const computed = getComputedStyle(root);
      const white = "0 0% 100%";
      const ink = "40 4.3% 13.5%";
      for (const tone of ["primary", "primary-dark"]) {
        const prefix = "--okou-color-theme-" + tone;
        const background = paletteLuminance(computed.getPropertyValue(prefix));
        const label = computed.getPropertyValue(prefix + "-foreground").trim();
        expect([white, ink]).toContain(label);
        const score = apcaMagnitude(paletteLuminance(label), background);
        expect(score).toBeGreaterThanOrEqual(60);
        expect(score).toBeGreaterThan(
          apcaMagnitude(
            paletteLuminance(label === ink ? white : ink),
            background,
          ),
        );
      }
    } finally {
      sheet.remove();
    }
  },
);
