import {
  browserContract,
  type BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("Window size settings retain each selected mode when reopened", async () => {
  const threadId = "a0000000-0000-4000-a000-000000000345";
  const path = `/browsers/${threadId}`;
  const cdpUrl = "wss://cdp.example.test/browser";
  const time = "2026-08-01T10:00:00.000Z";
  const viewer: BrowserViewerConnection = {
    browser: {
      threadId,
      name: "Research",
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
        instanceId: "a0000000-0000-4000-a000-000000000346",
        primaryWindowId: 1,
      },
    },
    cdpUrl,
    extension: TEST_BROWSER_EXTENSION,
  };
  mockBrowserCdp(context, cdpUrl, {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId: 1,
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: viewer.browser, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: viewer.browser });
  });

  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const settings = screen.getByLabelText("Browser settings");
  const openWindowSize = async () => {
    click(settings);
    click(await screen.findByText("Window size"));
  };
  await openWindowSize();
  expect(
    await screen.findByRole("menuitemradio", { name: "Follow panel" }),
  ).toBeChecked();

  for (const label of ["On connection", "Follow panel", "Off"]) {
    const option = await screen.findByRole("menuitemradio", { name: label });
    await waitFor(() => {
      expect(option).not.toHaveAttribute("aria-disabled", "true");
    });
    click(option);
    await waitFor(() => {
      expect(
        screen.queryByRole("menuitemradio", { name: label }),
      ).not.toBeInTheDocument();
    });
    await openWindowSize();
    expect(
      await screen.findByRole("menuitemradio", { name: label }),
    ).toBeChecked();
  }
});
