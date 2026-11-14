import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { mockMonotonicNow, mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";

function viewer() {
  let elapsed = 0;
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  mockNow(Date.parse("2026-09-01T10:00:00Z"), context.signal);
  const remote = mockBrowserCdp(context, "wss://browser.example/frame-window", {
    enforceFrameWindow: true,
  });
  const browser: BrowserSession = {
    threadId,
    name: "Window",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: null,
    screenshotUrl: null,
    timeoutMinutes: 10,
    idleExpiresAt: "2026-09-01T10:10:00Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 0,
    },
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser,
      viewer: {
        browser,
        cdpUrl: "wss://browser.example/frame-window",
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser });
  });
  return {
    remote,
    start: () => {
      return setupPage({ context, path: `/browsers/${threadId}` });
    },
    advance(ms: number) {
      elapsed += ms;
    },
  };
}

async function ready() {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
}

function menuItem(name: string) {
  const found = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!found) {
    throw new Error(`Missing menu item: ${name}`);
  }
  return found;
}

async function enableFps() {
  click(screen.getByLabelText("Browser settings"));
  await screen.findByRole("menu", { name: "Browser settings" });
  click(menuItem("FPS"));
  await screen.findByRole("menu", { name: "FPS" });
  const on = queryAllByRoleFast("menuitemradio").find((candidate) => {
    return candidate.textContent?.trim() === "On";
  });
  if (!on) {
    throw new Error("Missing FPS On choice");
  }
  click(on);
  await screen.findByRole("img", { name: "— FPS" });
}

async function paintedWindow(v: ReturnType<typeof viewer>, expected: number) {
  await enableFps();
  act(() => {
    return v.advance(100);
  });
  v.remote.holdFrameAcks();
  for (let index = 0; index < 30; index++) {
    await act(async () => {
      v.remote.frame("AAAA");
      await Promise.resolve();
    });
  }
  act(() => {
    return v.advance(900);
  });
  return screen.findByRole("img", { name: `${expected} FPS` });
}

test.each([
  { samples: [1, 2, 3], expected: 3 },
  { samples: [100, 200, 300], expected: 8 },
  { samples: [800, 1000, 1200], expected: 24 },
])(
  "Averaged RTT $samples allows $expected painted frames before ACKs return",
  async ({ samples, expected }) => {
    const v = viewer();
    const preparation = v.remote.holdNext("Target.setDiscoverTargets");
    let probe = v.remote.holdNext("Browser.getVersion");
    await v.start();
    for (const [index, sample] of samples.entries()) {
      await probe.received;
      const next =
        index < samples.length - 1
          ? v.remote.holdNext("Browser.getVersion")
          : null;
      await act(async () => {
        v.advance(sample);
        await probe.release();
      });
      if (next) {
        probe = next;
      }
    }
    await preparation.received;
    await act(() => {
      return preparation.release();
    });
    await ready();
    await expect(paintedWindow(v, expected)).resolves.toBeInTheDocument();
  },
);

test("A stalled optional probe does not delay a usable first image or input", async () => {
  const v = viewer();
  const probe = v.remote.holdNext("Browser.getVersion");
  await v.start();
  await probe.received;
  await ready();
  await expect(paintedWindow(v, 3)).resolves.toBeInTheDocument();
});

test("A rejected optional probe leaves the browser usable", async () => {
  const v = viewer();
  v.remote.failNext("Browser.getVersion", "Version read unavailable");
  await v.start();
  await ready();
  await expect(paintedWindow(v, 3)).resolves.toBeInTheDocument();
});

test("A late averaged estimate does not restart an already usable capture", async () => {
  const v = viewer();
  let probe = v.remote.holdNext("Browser.getVersion");
  await v.start();
  await probe.received;
  await ready();
  for (let sample = 0; sample < 3; sample++) {
    const next = sample < 2 ? v.remote.holdNext("Browser.getVersion") : null;
    await act(async () => {
      v.advance(500);
      await probe.release();
    });
    if (next) {
      probe = next;
      await probe.received;
    }
  }
  await expect(paintedWindow(v, 3)).resolves.toBeInTheDocument();
});

test("A split image socket sizes its window independently of the retired shared socket", async () => {
  const v = viewer();
  const oldProbe = v.remote.holdNext("Browser.getVersion");
  await v.start();
  await oldProbe.received;
  await ready();

  const preparation = v.remote.holdNext("Target.setDiscoverTargets");
  let probe = v.remote.holdNext("Browser.getVersion");
  click(screen.getByLabelText("Browser settings"));
  await screen.findByRole("menu", { name: "Browser settings" });
  click(menuItem("Connection mode"));
  await screen.findByRole("menu", { name: "Connection mode" });
  const split = queryAllByRoleFast("menuitemradio").find((candidate) => {
    return candidate.textContent?.trim() === "Separate image connection";
  });
  if (!split) {
    throw new Error("Missing separate image connection choice");
  }
  click(split);
  for (let sample = 0; sample < 3; sample++) {
    await probe.received;
    const next = sample < 2 ? v.remote.holdNext("Browser.getVersion") : null;
    await act(async () => {
      v.advance(200);
      await probe.release();
    });
    if (next) {
      probe = next;
    }
  }
  await preparation.received;
  await act(async () => {
    await oldProbe.release();
    await preparation.release();
  });
  await ready();
  await expect(paintedWindow(v, 8)).resolves.toBeInTheDocument();
});
