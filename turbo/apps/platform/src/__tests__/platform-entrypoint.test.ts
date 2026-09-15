import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { startPlatformEntrypoint } from "../lib/platform-entrypoint.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();
const GOOGLE_TAG_SCRIPT_URL =
  "https://www.googletagmanager.com/gtag/js?id=AW-18144854014";

let googleAdsRequestedAfterApplicationStart = false;
async function waitForApplicationStart(): Promise<void> {
  await waitFor(() => {
    expect(document.getElementById("root")?.childElementCount).toBeGreaterThan(
      0,
    );
  });
}

describe("platform entrypoint", () => {
  beforeEach(() => {
    googleAdsRequestedAfterApplicationStart = false;
    context.mocks.browser.url("https://app.okou.ai/");
    context.mocks.clerk();
    context.mocks.posthog();
    context.mocks.sentry();
    const root = document.createElement("div");
    root.id = "root";
    document.body.replaceChildren(root);

    const appendChild = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, "appendChild").mockImplementation(
      <T extends Node>(node: T): T => {
        if (
          node instanceof HTMLScriptElement &&
          node.src === GOOGLE_TAG_SCRIPT_URL
        ) {
          googleAdsRequestedAfterApplicationStart =
            context.mocks.sentry().initializations.length > 0;
        }
        return appendChild(node);
      },
    );
  });

  it("does not start without the inline lifecycle", () => {
    vi.stubGlobal("SharedWorker", class extends EventTarget {});
    delete window._okou;

    expect(startPlatformEntrypoint).toThrow(
      "Platform lifecycle was not initialized",
    );
    expect(context.mocks.sentry().initializations).toHaveLength(0);
    expect(document.getElementById("root")).toBeEmptyDOMElement();
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

  it("starts the application before requesting Google Ads", async () => {
    context.mocks.browser.userAgent(
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
    );
    vi.stubGlobal("SharedWorker", class extends EventTarget {});
    startPlatformEntrypoint();
    await waitForApplicationStart();
    expect(googleAdsRequestedAfterApplicationStart).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /browser to continue/ }),
    ).toBeNull();
  });

  it.each([138, 142, 143])(
    "shows browser guidance before bootstrap on Android Chrome %s without SharedWorker",
    async (version) => {
      context.mocks.browser.userAgent(
        `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Mobile Safari/537.36`,
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
    },
  );

  it("keeps version upgrade guidance for an older browser with SharedWorker", async () => {
    context.mocks.browser.userAgent(
      "Mozilla/5.0 Chrome/110.0.0.0 Safari/537.36",
    );
    vi.stubGlobal("SharedWorker", class extends EventTarget {});
    startPlatformEntrypoint();
    await expect(
      screen.findByRole("heading", { name: "Update Chrome to continue" }),
    ).resolves.toBeVisible();
    expect(context.mocks.sentry().initializations).toHaveLength(0);
  });
});
