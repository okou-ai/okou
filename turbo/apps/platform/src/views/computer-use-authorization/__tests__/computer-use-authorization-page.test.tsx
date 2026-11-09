import {
  computerUseAuthorizationRequestsContract,
  type ComputerUseAuthorizationSource,
  type ComputerUseHost,
} from "@okouai/api-contracts/contracts/computer-use";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const REQUEST_TOKEN = "computer-use-request-token";
const OFFLINE_HOST_ID = "33333333-3333-4333-8333-333333333333";

function computerUseHost(
  id: string,
  displayName: string,
  overrides: Partial<ComputerUseHost> = {},
): ComputerUseHost {
  return {
    id,
    hostName: displayName,
    displayName,
    appVersion: "1.0.0",
    osVersion: "14.6",
    supportedCapabilities: [],
    permissions: {
      accessibility: true,
      screenRecording: true,
      automation: {
        chrome: { status: "granted", updatedAt: null, reason: null },
        safari: { status: "granted", updatedAt: null, reason: null },
      },
    },
    status: "online",
    lastSeenAt: "2026-09-01T10:00:00.000Z",
    createdAt: "2026-09-01T09:00:00.000Z",
    ...overrides,
  };
}

function mockAuthorizationRequest({
  hosts,
  source = "chat",
}: {
  readonly hosts: ComputerUseHost[];
  readonly source?: ComputerUseAuthorizationSource;
}): void {
  context.mocks.api(
    computerUseAuthorizationRequestsContract.get,
    ({ respond }) => {
      return respond(200, {
        source,
        chatThreadId:
          source === "chat" ? "20000000-0000-4000-8000-000000000001" : null,
        expiresAt: "2099-09-01T10:00:00.000Z",
        completedAt: null,
        computerUseHostId: null,
        hosts,
      });
    },
  );
}

function getButton(
  name: string,
  container: ParentNode = document.body,
): HTMLButtonElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function getDownloadLink(): HTMLAnchorElement | undefined {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === "Download for macOS";
  });
  return link instanceof HTMLAnchorElement ? link : undefined;
}

function mockIntelMac(): void {
  const original = Object.getOwnPropertyDescriptor(navigator, "userAgentData");
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: {
      platform: "macOS",
      getHighEntropyValues: () => {
        return Promise.resolve({
          architecture: "x86_64",
          platform: "macOS",
        });
      },
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (original) {
        Object.defineProperty(navigator, "userAgentData", original);
      } else {
        Reflect.deleteProperty(navigator, "userAgentData");
      }
    },
    { once: true },
  );
}

test("An Intel Mac cannot download the unsupported computer-use app", async () => {
  mockIntelMac();
  mockAuthorizationRequest({ hosts: [] });

  await setupPage({
    context,
    path: `/computer-use/authorize/${REQUEST_TOKEN}`,
    host: "app.okou.ai",
  });

  await expect(
    screen.findByRole("heading", { name: "No online computers" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(getButton("Requires an Apple silicon Mac")).toBeDisabled();
  });
  expect(
    screen.getByText(
      "Requires an Apple silicon Mac with macOS 14 or newer. Intel Macs aren't supported.",
    ),
  ).toBeVisible();
  expect(getDownloadLink()).toBeUndefined();
});

test("A user with no online computer receives setup guidance", async () => {
  mockAuthorizationRequest({
    hosts: [
      computerUseHost(OFFLINE_HOST_ID, "Offline Desktop", {
        status: "offline",
      }),
    ],
  });

  await setupPage({
    context,
    path: `/computer-use/authorize/${REQUEST_TOKEN}`,
    host: "app.okou.ai",
  });

  await expect(
    screen.findByRole("heading", { name: "No online computers" }),
  ).resolves.toBeVisible();
  expect(
    screen.getByText("Open Okou on your Mac to bring it online."),
  ).toBeVisible();
  expect(screen.queryByText("Offline Desktop")).toBeNull();
  expect(
    screen.getByText(
      "Requires an Apple silicon Mac with macOS 14 or newer. Intel Macs aren't supported.",
    ),
  ).toBeVisible();
  expect(getDownloadLink()).toHaveAttribute(
    "href",
    expect.stringContaining("/api/desktop/updates/stable/darwin/arm64/dmg"),
  );
});

test("The standalone Web authorization follows Run readiness and authorizes once", async () => {
  const host = computerUseHost(
    "30000000-0000-4000-8000-000000000001",
    "Test Mac",
  );
  let ready = false;
  let completed = false;
  context.mocks.api(
    computerUseAuthorizationRequestsContract.get,
    ({ respond }) => {
      return respond(200, {
        source: "chat",
        chatThreadId: "20000000-0000-4000-8000-000000000001",
        expiresAt: "2099-09-01T10:00:00.000Z",
        completedAt: completed ? "2026-11-09T04:00:00.000Z" : null,
        computerUseHostId: completed ? host.id : null,
        hosts: [host],
        continuation: { blockedReason: ready ? null : "run_active" },
      });
    },
  );
  context.mocks.api(
    computerUseAuthorizationRequestsContract.apply,
    ({ respond }) => {
      completed = true;
      return respond(200, {
        ok: true,
        source: "chat",
        computerUseHostId: host.id,
        continuationEnqueued: true,
      });
    },
  );
  await setupPage({
    context,
    path: `/computer-use/authorize/${REQUEST_TOKEN}`,
    host: "app.okou.ai",
  });
  await waitFor(() => {
    return expect(getButton("Authorize and continue")).toBeDisabled();
  });
  expect(
    screen.getByText("Wait for the requesting Run to finish before approving."),
  ).toBeInTheDocument();
  ready = true;
  context.mocks.ably.trigger("desktopShellAuthorizationChanged");
  await waitFor(() => {
    return expect(getButton("Authorize and continue")).toBeEnabled();
  });
  click(getButton("Authorize and continue"));
  await waitFor(() => {
    return expect(getButton("Authorized")).toBeDisabled();
  });
});
