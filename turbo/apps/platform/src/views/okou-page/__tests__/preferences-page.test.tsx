// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import entryCss from "../../css/index.css?inline";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
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
    path: "/?settings=my-okou",
  });
  await expect(
    screen.findByText("Set a valid time zone before enabling Morning Brief."),
  ).resolves.toBeVisible();
  click(await findAction("button", "Preference"));
  const zone = await screen.findByRole("combobox", { name: /time zone/i });
  expect(zone).toHaveTextContent("UTC");
  click(zone);
  click(await screen.findByRole("option", { name: / Eastern Time \(ET\)$/ }));
  await waitFor(() => {
    return expect(zone).toHaveTextContent(/Eastern Time/);
  });
  expect(zone).toBeEnabled();
  click(await findAction("button", "My Okou"));
  await waitFor(() => {
    return expect(
      screen.getByRole("switch", { name: /morning brief/i }),
    ).toBeChecked();
  });
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

test.each([
  ["dark", null, null, "System", "Default"],
  ["light", "dark", "golden-hour", "Dark", "Golden hour"],
] as const)(
  "Workspace appearance and palette after a %s first-paint cookie",
  async (cookie, persisted, palette, mode, selected) => {
    context.mocks.browser.cookie("__Secure-okou-theme=v1." + cookie);
    workspace(persisted, palette);
    await setupPage({ context, path: "/preferences" });
    const selectedPalette = await findAction("button", selected);
    await waitFor(() => {
      return expect(selectedPalette).toHaveAttribute("aria-pressed", "true");
    });
    expect(getAction("button", mode)).toHaveAttribute("aria-pressed", "true");
    const next = mode === "Dark" ? "Light" : "Dark";
    click(getAction("button", next));
    await waitFor(() => {
      return expect(document.documentElement.dataset.theme).toBe(
        next.toLowerCase(),
      );
    });
    expect(selectedPalette).toHaveAttribute("aria-pressed", "true");
  },
);

test.each([
  ["color-themes-008", "Golden hour"],
  ["color-themes-009", "Citrus spark"],
  ["color-themes-010", "Berry blush"],
  ["color-themes-011", "Cotton sky"],
  ["color-themes-012", "Blue horizon"],
])(
  "%s keeps both ambient strengths in percentage units when switching appearance",
  async (_id, paletteName) => {
    workspace("light", null);
    await setupPage({ context, path: "/preferences" });
    const palette = await findAction("button", paletteName);
    const style = document.createElement("style");
    style.append(entryCss);
    document.head.appendChild(style);
    try {
      click(palette);
      for (const mode of ["Light", "Dark"]) {
        click(await findAction("button", mode));
        await waitFor(() => {
          expect(palette).toHaveAttribute("aria-pressed", "true");
          expect(document.documentElement.dataset.colorTheme).toBe(
            paletteName.toLowerCase().replaceAll(" ", "-"),
          );
          expect(document.documentElement).toHaveAttribute(
            "data-theme",
            mode.toLowerCase(),
          );
          const suffix = mode === "Light" ? "" : "-dark";
          const colors = getComputedStyle(document.documentElement);
          for (const role of ["anchor", "companion"]) {
            const value = colors.getPropertyValue(
              "--okou-color-theme-ambient-" + role + suffix,
            );
            expect(value.trim()).toMatch(/^\d+(?:\.\d+)?%$/u);
          }
        });
      }
    } finally {
      style.remove();
    }
  },
);

test("The workspace appearance replaces the two inherited browser theme cookies", async () => {
  const host = "app.vm0.ai";
  context.mocks.browser.url("https://" + host + "/");
  const name = "__Secure-okou-theme";
  // oxlint-disable-next-line unicorn/no-document-cookie -- seed separate shared and host-only entries in the browser jar.
  document.cookie = name + "=v1.dark; Domain=.vm0.ai; Path=/; Secure";
  // oxlint-disable-next-line unicorn/no-document-cookie -- the host-only cookie must omit Domain.
  document.cookie = name + "=v1.light; Path=/; Secure";
  const values = () => {
    return document.cookie
      .split(";")
      .map((part) => {
        return part.trim();
      })
      .filter((part) => {
        return part.startsWith(name + "=");
      });
  };
  expect(values().sort()).toStrictEqual([
    name + "=v1.dark",
    name + "=v1.light",
  ]);
  const { prefs } = workspace("dark", null);
  const release = context.mocks.deferred<void>();
  const reading = context.mocks.deferred<void>();
  context.mocks.api(userPreferencesContract.get, async ({ respond }) => {
    if (!reading.settled()) {
      reading.resolve();
    }
    await release.promise;
    return respond(200, prefs);
  });
  const opening = await startPage({ context, host, path: "/preferences" });
  await reading.promise;
  release.resolve();
  await opening.ready;
  const dark = await findAction("button", "Dark");
  await waitFor(() => {
    return expect(dark).toHaveAttribute("aria-pressed", "true");
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(values()).toStrictEqual([name + "=v1.dark"]);
  context.mocks.browser.url("https://workspace.vm0.ai/");
  expect(values()).toStrictEqual([name + "=v1.dark"]);
});
