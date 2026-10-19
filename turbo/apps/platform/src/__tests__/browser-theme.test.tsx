import { screen, waitFor } from "@testing-library/react";
import { onTestFinished, expect, test } from "vitest";

import indexHtml from "../../index.html?raw";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { click, queryAllByRoleFast, setupPage } from "./page-helper.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();
const DARK_QUERY = "(prefers-color-scheme: dark)";

function installBrowserSurface() {
  const page = new DOMParser().parseFromString(indexHtml, "text/html");
  const metas = [...page.querySelectorAll('meta[name="theme-color"]')];
  const style = document.createElement("style");
  // happy-dom does not resolve the application's nested CSS color variables.
  // Supply the browser's resolved surfaces while exercising the real theme
  // bootstrap, settings controls, and document metadata.
  style.textContent = `
    :root { background-color: rgb(255, 255, 255); }
    :root[data-theme="dark"] { background-color: rgb(36, 35, 33); }
    :root[data-color-theme="golden-hour"] { background-color: rgb(253, 252, 251); }
    :root[data-theme="dark"][data-color-theme="golden-hour"] { background-color: rgb(36, 34, 32); }
  `;
  document.head.append(style, ...metas);
  onTestFinished(() => {
    style.remove();
    for (const meta of metas) {
      meta.remove();
    }
  });
}

function browserThemeColor() {
  return [
    ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  ].find((meta) => {
    return !meta.media || window.matchMedia(meta.media).matches;
  });
}

function appearanceButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent === name;
  });
  if (!button) {
    throw new Error(`Missing appearance option: ${name}`);
  }
  return button;
}

test.each([
  { preference: "dark", systemDark: false, color: "rgb(36, 35, 33)" },
  { preference: "light", systemDark: true, color: "rgb(255, 255, 255)" },
  { preference: "system", systemDark: true, color: "rgb(36, 35, 33)" },
  { preference: "system", systemDark: false, color: "rgb(255, 255, 255)" },
])(
  "First paint uses $preference with systemDark=$systemDark for browser chrome",
  ({ preference, systemDark, color }) => {
    installBrowserSurface();
    context.mocks.browser.cookie(`__Secure-okou-theme=v1.${preference}`);
    context.mocks.browser.matchMedia((query) => {
      return query === DARK_QUERY && systemDark;
    });
    const page = new DOMParser().parseFromString(indexHtml, "text/html");
    const source = page.querySelector("#theme-bootstrap")?.textContent;
    if (!source) {
      throw new Error("Missing theme bootstrap");
    }

    // Execute the browser entry point before the application is mounted.
    new Function(source)();

    expect(browserThemeColor()).toHaveAttribute("content", color);
  },
);

test("Browser chrome follows appearance and palette choices in Settings", async () => {
  installBrowserSurface();
  context.mocks.browser.cookie("__Secure-okou-theme=v1.light");
  context.mocks.browser.matchMedia((query) => {
    return query === DARK_QUERY;
  });
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, {
      timezone: "Etc/UTC",
      locale: "en-US",
      supportedLocales: ["en-US"],
      pinnedAgentIds: [],
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      chatResourcesEnabledByDefault: true,
      theme: "system",
      colorTheme: "default",
      captureNetworkBodiesRemaining: 0,
      memoryInitialized: true,
    });
  });

  await setupPage({ context, path: "/settings", host: "app.okou.ai" });
  await screen.findByText("Your preferred color scheme");
  expect(browserThemeColor()).toHaveAttribute("content", "rgb(255, 255, 255)");

  click(appearanceButton("Dark"));
  await waitFor(() => {
    expect(browserThemeColor()).toHaveAttribute("content", "rgb(36, 35, 33)");
  });

  click(appearanceButton("Golden hour"));
  await waitFor(() => {
    expect(browserThemeColor()).toHaveAttribute("content", "rgb(36, 34, 32)");
  });

  click(appearanceButton("Light"));
  await waitFor(() => {
    expect(browserThemeColor()).toHaveAttribute(
      "content",
      "rgb(253, 252, 251)",
    );
  });

  click(appearanceButton("Default"));
  await waitFor(() => {
    expect(browserThemeColor()).toHaveAttribute(
      "content",
      "rgb(255, 255, 255)",
    );
  });
});

test("Browser chrome follows system changes and a theme changed in another tab", async () => {
  installBrowserSurface();
  context.mocks.browser.cookie("__Secure-okou-theme=v1.system");
  const system = context.mocks.browser.matchMedia(false);

  await setupPage({ context, path: "/settings", host: "app.okou.ai" });
  await screen.findByText("Your preferred color scheme");
  expect(browserThemeColor()).toHaveAttribute("content", "rgb(255, 255, 255)");

  system.setMatches((query) => {
    return query === DARK_QUERY;
  });
  await waitFor(() => {
    expect(browserThemeColor()).toHaveAttribute("content", "rgb(36, 35, 33)");
  });

  context.mocks.browser.cookie("__Secure-okou-theme=v1.light");
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => {
    expect(browserThemeColor()).toHaveAttribute(
      "content",
      "rgb(255, 255, 255)",
    );
  });
});
