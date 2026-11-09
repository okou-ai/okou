import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import { posthog } from "posthog-js/dist/module.slim";

import { startPlatformEntrypoint } from "../lib/platform-entrypoint.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();
async function waitForApplicationStart(): Promise<void> {
  await waitFor(() => {
    expect(document.getElementById("root")?.childElementCount).toBeGreaterThan(
      0,
    );
  });
}

describe("platform entrypoint", () => {
  beforeEach(() => {
    context.mocks.browser.url("https://app.okou.ai/");
    context.mocks.clerk();
    context.mocks.posthog();
    context.mocks.sentry();
    const root = document.createElement("div");
    root.id = "root";
    document.body.replaceChildren(root);
  });

  it("does not start with an aborted root signal", () => {
    vi.stubGlobal("SharedWorker", class extends EventTarget {});
    const okou = window._okou;
    if (!okou) {
      throw new Error("Expected the inline lifecycle");
    }
    const reason = new DOMException("Page stopped", "AbortError");
    window._okou = { ...okou, rootSignal: AbortSignal.abort(reason) };

    expect(startPlatformEntrypoint).toThrow(reason);
    expect(context.mocks.sentry().initializations).toHaveLength(0);
    expect(document.getElementById("root")).toBeEmptyDOMElement();
  });

  it.each([
    "Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36",
    "Mozilla/5.0 Chromium/138.0.0.0 Safari/537.36",
    "Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
    "Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36 OPR/123.0.0.0",
    "Mozilla/5.0 (Linux; Android 14) Chrome/148.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; wv) Chrome/148.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
    "Mozilla/5.0 (Macintosh) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) CriOS/111.0 Mobile/15E148 Safari/604.1",
  ])("starts at the supported browser boundary: %s", async (userAgent) => {
    context.mocks.browser.userAgent(userAgent);
    vi.stubGlobal("SharedWorker", class extends EventTarget {});
    startPlatformEntrypoint();
    await waitForApplicationStart();
    expect(context.mocks.sentry().initializations).toHaveLength(1);
    expect(
      screen.queryByRole("heading", { name: /browser to continue/ }),
    ).toBeNull();
  });

  it.each([
    {
      userAgent: "Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36",
      title: "Update Chrome to continue",
      actionUrl: "https://www.google.com/chrome/",
    },
    {
      userAgent: "Mozilla/5.0 Chromium/137.0.0.0 Safari/537.36",
      title: "Update Chromium to continue",
      actionUrl: "https://www.chromium.org/getting-involved/download-chromium/",
    },
    {
      userAgent: "Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0",
      title: "Update Edge to continue",
      actionUrl: "https://www.microsoft.com/edge/download",
    },
    {
      userAgent:
        "Mozilla/5.0 (Android 14) Chrome/147.0.0.0 Safari/537.36 EdgA/147.0.0.0",
      title: "Update Edge to continue",
      actionUrl: "https://www.microsoft.com/edge/download",
    },
    {
      userAgent: "Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36 OPR/123.0.0.0",
      title: "Use a supported browser to continue",
      actionUrl: "https://www.google.com/chrome/",
    },
    {
      userAgent:
        "Mozilla/5.0 (Android 14) Chrome/147.0.0.0 Safari/537.36 SamsungBrowser/30.0",
      title: "Use a supported browser to continue",
      actionUrl: "https://www.google.com/chrome/",
    },
    {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; wv) Chrome/142.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0",
      title: "Use a supported browser to continue",
      actionUrl: "https://www.google.com/chrome/",
    },
    {
      userAgent:
        "Mozilla/5.0 (Android 14) Chrome/147.0.0.0 Mobile Safari/537.36",
      title: "Update Chrome to continue",
      actionUrl: "https://www.google.com/chrome/",
    },
    {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
      title: "Update Firefox to continue",
      actionUrl: "https://www.mozilla.org/firefox/new/",
    },
    {
      userAgent: "Mozilla/5.0 (Macintosh) Version/18.1 Safari/605.1.15",
      title: "Update Safari to continue",
      actionUrl: "https://support.apple.com/safari",
    },
    {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) CriOS/150.0 Mobile/15E148 Safari/604.1",
      title: "Update iOS to continue",
      actionUrl: "https://support.apple.com/HT204204",
    },
  ])(
    "shows accurate upgrade guidance: $userAgent",
    async ({ userAgent, title, actionUrl }) => {
      context.mocks.browser.userAgent(userAgent);
      vi.stubGlobal("SharedWorker", class extends EventTarget {});
      startPlatformEntrypoint();
      await expect(
        screen.findByRole("heading", { name: title }),
      ).resolves.toBeVisible();
      expect(document.querySelector(`a[href="${actionUrl}"]`)).toBeVisible();
      expect(context.mocks.sentry().initializations).toHaveLength(0);
    },
  );

  it("strips Discord approval fragments synchronously before analytics initialize", async () => {
    const proof = "p".repeat(43);
    const attemptState = "s".repeat(43);
    context.mocks.browser.url(
      `https://app.okou.ai/works?discord=pending#discord_oauth=approve&state=${attemptState}&approval_proof=${proof}`,
    );
    context.mocks.browser.userAgent(
      "Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36",
    );
    vi.stubGlobal("SharedWorker", class extends EventTarget {});
    const analyticsUrls: string[] = [];
    vi.spyOn(Sentry, "init").mockImplementation(() => {
      analyticsUrls.push(window.location.href);
      return undefined;
    });
    vi.spyOn(posthog, "init").mockImplementation(() => {
      analyticsUrls.push(window.location.href);
      return posthog;
    });
    startPlatformEntrypoint();
    expect(window.location.hash).toBe("");
    expect(analyticsUrls.length).toBeGreaterThan(0);
    expect(analyticsUrls).toStrictEqual(
      analyticsUrls.map(() => {
        return "https://app.okou.ai/works?discord=pending";
      }),
    );
    await waitForApplicationStart();
  });

  it("shows browser guidance before bootstrap when SharedWorker is unavailable", async () => {
    context.mocks.browser.userAgent(
      "Mozilla/5.0 (Linux; Android 14) Chrome/148.0.0.0 Mobile Safari/537.36",
    );
    vi.stubGlobal("SharedWorker", undefined);
    startPlatformEntrypoint();
    await expect(
      screen.findByRole("heading", {
        name: "Use a supported browser to continue",
      }),
    ).resolves.toBeVisible();
    expect(
      document.querySelector('a[href="https://www.google.com/chrome/"]'),
    ).toBeVisible();
    expect(context.mocks.sentry().initializations).toHaveLength(0);
    expect(context.mocks.sentry().reports).toHaveLength(0);
  });
});
