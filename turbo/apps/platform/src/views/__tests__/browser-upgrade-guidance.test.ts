import { screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { startPlatformEntrypoint } from "../../lib/platform-entrypoint.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { createBootstrapRoot } from "../../test/bootstrap-skeleton.ts";

const context = testContext();

test.each([
  {
    id: "platform-entrypoint-012",
    browser: "desktop Chrome",
    ua: "Mozilla/5.0 Chrome/137.0",
    heading: "Update Chrome to continue",
    link: "Update Chrome",
    url: "https://www.google.com/chrome/",
  },
  {
    id: "platform-entrypoint-013",
    browser: "desktop Chromium",
    ua: "Mozilla/5.0 Chromium/137.0",
    heading: "Update Chromium to continue",
    link: "Update Chromium",
    url: "https://www.chromium.org/getting-involved/download-chromium/",
  },
  {
    id: "platform-entrypoint-014",
    browser: "desktop Edge",
    ua: "Mozilla/5.0 Chrome/137.0 Edg/137.0",
    heading: "Update Edge to continue",
    link: "Update Edge",
    url: "https://www.microsoft.com/edge/download",
  },
  {
    id: "platform-entrypoint-015",
    browser: "mobile Edge",
    ua: "Mozilla/5.0 (Linux; Android 14) Chrome/137.0 Mobile EdgA/137.0",
    heading: "Update Edge to continue",
    link: "Update Edge",
    url: "https://www.microsoft.com/edge/download",
  },
  {
    id: "platform-entrypoint-016",
    browser: "desktop Opera",
    ua: "Mozilla/5.0 Chrome/137.0 OPR/123.0",
    heading: "Use a supported browser to continue",
    link: "Get the latest Chrome",
    url: "https://www.google.com/chrome/",
  },
  {
    id: "platform-entrypoint-020",
    browser: "desktop Firefox",
    ua: "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/127.0",
    heading: "Update Firefox to continue",
    link: "Update Firefox",
    url: "https://www.mozilla.org/firefox/new/",
  },
  {
    id: "platform-entrypoint-021",
    browser: "macOS Safari",
    ua: "Mozilla/5.0 (Macintosh) Version/18.1 Safari/605.1",
    heading: "Update Safari to continue",
    link: "Update Safari",
    url: "https://support.apple.com/safari",
  },
  {
    id: "platform-entrypoint-022",
    browser: "iPhone Chrome",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) CriOS/150.0 Mobile Safari/604.1",
    heading: "Update iOS to continue",
    link: "Update iOS",
    url: "https://support.apple.com/HT204204",
  },
])(
  "$id directs a visitor using $browser to its download page",
  async ({ ua, heading, link, url }) => {
    const telemetry = context.mocks.sentry();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
    const root = createBootstrapRoot();
    document.body.append(root);
    try {
      startPlatformEntrypoint();
      const guidance = within(await screen.findByRole("status"));
      expect(guidance.getByRole("heading", { name: heading })).toBeVisible();
      expect(guidance.getByText(link, { selector: "a" })).toHaveAttribute(
        "href",
        url,
      );
      expect(telemetry.initializations).toStrictEqual([]);
      expect(telemetry.reports).toStrictEqual([]);
    } finally {
      root.remove();
    }
  },
);

test("platform-entrypoint-001 An abandoned page preserves its original cancellation reason", () => {
  const reason = new DOMException("Page stopped", "AbortError");
  vi.stubGlobal("_okou", {
    ...window._okou,
    rootSignal: AbortSignal.abort(reason),
  });
  const telemetry = context.mocks.sentry();
  const root = createBootstrapRoot();
  document.body.append(root);
  try {
    let stopped: unknown;
    try {
      startPlatformEntrypoint();
    } catch (error) {
      stopped = error;
    }
    expect(stopped).toBe(reason);
    expect(root).toBeEmptyDOMElement();
    expect(telemetry.initializations).toStrictEqual([]);
  } finally {
    root.remove();
  }
});
