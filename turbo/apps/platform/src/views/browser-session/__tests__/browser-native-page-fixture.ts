import {
  browserContract,
  type BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { HttpResponse } from "msw";

import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function arrangeNativePage(
  context: TestContext,
  options: NonNullable<Parameters<typeof mockBrowserCdp>[2]> = {},
  windowId = 101,
) {
  const threadId = "a0000000-0000-4000-a000-000000000871";
  const path = `/browsers/${threadId}`;
  const cdpUrl = "wss://cdp.example.test/native";
  const time = "2026-08-01T10:00:00.000Z";
  const viewer: BrowserViewerConnection = {
    browser: {
      threadId,
      name: "Shared browser",
      status: "active",
      viewerUrl: `https://app.okou.ai${path}`,
      liveUrl: null,
      screenshotUrl: null,
      timeoutMinutes: 10,
      idleExpiresAt: null,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: time,
      updatedAt: time,
      window: {
        instanceId: "a0000000-0000-4000-a000-000000000872",
        primaryWindowId: windowId,
      },
    },
    cdpUrl,
    extension: TEST_BROWSER_EXTENSION,
  };
  const cdp = mockBrowserCdp(context, cdpUrl, {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId,
      },
    ],
    ...options,
  });
  context.mocks.http.get("https://api.instatus.com/issues", () => {
    return HttpResponse.json({ activeIncidents: [] });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: viewer.browser, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: viewer.browser });
  });
  return {
    cdp,
    viewer,
    async openPage(pageContext = context) {
      await setupPage({
        context: pageContext,
        path,
        host: "app.okou.ai",
        featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
      });
    },
  };
}

export async function expectStreamingAt(address: string) {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveValue(address);
    expect(
      screen.getByRole("img", { name: "Live browser view" }),
    ).toBeInTheDocument();
  });
}
