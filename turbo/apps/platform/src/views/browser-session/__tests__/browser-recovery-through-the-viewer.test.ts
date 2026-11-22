import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { mockMonotonicNow, mockNow } from "../../../lib/time.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
import {
  findFastControl,
  queryFastControl,
} from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";

const context = testContext();
const first = "https://example.com",
  second = "https://other.example";
function desktop() {
  mockMonotonicNow(() => {
    return performance.now() * 10;
  }, context.signal);
  const reports = context.mocks.sentry().reports;
  initSentry();
  const page = arrangeNativePage(context, {
    targets: [
      { targetId: "main-tab", title: "Original", url: first, windowId: 101 },
      { targetId: "notes-tab", title: "Other", url: second, windowId: 101 },
    ],
  });
  return { ...page, reports };
}
type Desktop = ReturnType<typeof desktop>;
const input = () => {
  return screen.getByLabelText("Remote browser input");
};
const field = () => {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Address" });
};
const lost = (d: Desktop) => {
  return d.cdp.disconnect({ code: 1006, reason: "Local desktop went offline" });
};
async function typeOn(d: Desktop, target: string, text: string) {
  const remote = input();
  remote.focus();
  fireEvent.input(remote, {
    target: { value: text },
    data: text,
    inputType: "insertText",
  });
  await waitFor(() => {
    return expect(d.cdp.inputForTarget(target)).toContainEqual(
      expect.objectContaining({ method: "Input.insertText", params: { text } }),
    );
  });
}
function tab(id: string) {
  const found = queryFastControl("tab", id);
  if (!found) {
    throw new Error("Missing tab " + id);
  }
  return found;
}
function imageError(d: Desktop) {
  return d.cdp.frame("%invalid-base64%", d.cdp.pageSession("main-tab"));
}
async function ready(d: Desktop) {
  await d.openPage();
  await expectStreamingAt(first);
}
function refresh(d: Desktop) {
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: d.viewer.browser.threadId,
  });
}

test("browser-automatic-recovery-043 Exhausted service errors expose manual reconnect and the restored service accepts input", async () => {
  const d = desktop();
  const outages: string[] = [];
  const faults = ["BOOTING_DESKTOP", "RESUMING_STORAGE", "LAST_SERVICE_OUTAGE"];
  mockMonotonicNow(() => {
    return performance.now() * 10;
  }, context.signal);
  context.mocks.api(browserContract.get, ({ respond }) => {
    const message = outages.shift();
    return message
      ? respond(500, { error: { code: message, message } })
      : respond(200, { browser: d.viewer.browser, viewer: d.viewer });
  });
  await ready(d);
  outages.push(...faults);
  lost(d);
  await waitFor(() => {
    return expect(d.reports).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          contexts: expect.objectContaining({
            browser_recovery: { outcome: "exhausted" },
            browser_http: { status: 500, code: "LAST_SERVICE_OUTAGE" },
          }),
        }),
      }),
    );
  });
  expect(input()).toBeDisabled();
  const reconnect = await findFastControl("button", "Reconnect");
  expect(reconnect).toBeEnabled();
  click(reconnect);
  await expectStreamingAt(first);
  await typeOn(d, "main-tab", "normal again");
});
test("browser-automatic-recovery-065 A failed minute lease is processed while the same remote browser still accepts input", async () => {
  const d = desktop();
  const expiry = context.mocks.deferred<void>();
  let renewed = false;
  const later = context.mocks.deferred<void>(),
    releaseRenewal = context.mocks.deferred<void>();
  let now = Date.UTC(2026, 8, 1);
  mockNow(() => {
    return now;
  }, context.signal);
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    if (!renewed) {
      renewed = true;
      await expiry.promise;
      return respond(503, {
        error: { code: "UNAVAILABLE", message: "Temporary lease outage" },
      });
    }
    if (!later.settled()) {
      later.resolve();
    }
    await releaseRenewal.promise;
    return respond(200, { browser: d.viewer.browser });
  });
  try {
    await ready(d);
    const session = d.cdp.pageSession("main-tab");
    d.cdp.setAutoOpen(false);
    expiry.resolve();
    await later.promise;
    await waitFor(() => {
      return expect(d.reports).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.stringContaining("heartbeat failed"),
        }),
      );
    });
    now += 61_000;
    releaseRenewal.resolve();
    await typeOn(d, "main-tab", "After lease renewal");
    expect(d.cdp.pageSession("main-tab")).toBe(session);
  } finally {
    if (!expiry.settled()) {
      expiry.resolve();
    }
    if (!releaseRenewal.settled()) {
      releaseRenewal.resolve();
    }
  }
});
test("browser-automatic-recovery-066 A transient native tab read leaves the selected document on its existing connection", async () => {
  const d = desktop();
  await ready(d);
  click(tab("Other"));
  await expectStreamingAt(second);
  const session = d.cdp.pageSession("notes-tab"),
    owner = d.cdp.requests.find((r) => {
      return r.sessionId === session;
    })?.connectionId;
  d.cdp.setAutoOpen(false);
  const selected = d.cdp.targets.find((t) => {
    return t.targetId === "notes-tab";
  })!;
  const read = d.cdp.holdNextNative("getWindow");
  d.cdp.failNext("Runtime.evaluate", "Temporary native read failure", -32_001);
  d.cdp.nativeEvent("tab-attached", selected);
  expect(JSON.parse(await read.received)).toMatchObject({
    error: { code: -32_001 },
  });
  await read.release();
  await screen.findByText("Reconnecting…");
  await waitFor(() => {
    return expect(screen.queryByText("Reconnecting…")).toBeNull();
  });
  await expectStreamingAt(second);
  expect(tab("Other")).toHaveAttribute("aria-selected", "true");
  await typeOn(d, "notes-tab", "Restored selection");
  expect(
    d.cdp.requests.find((r) => {
      return r.method === "Input.insertText";
    })?.connectionId,
  ).toBe(owner);
});
test("browser-automatic-recovery-074 Native selection remains active after an image failure and transport loss", async () => {
  const d = desktop();
  await ready(d);
  const pending = d.cdp.holdTargetFrames("main-tab");
  imageError(d);
  await pending.received;
  const target = d.cdp.targets.find((t) => {
    return t.targetId === "notes-tab";
  })!;
  d.cdp.event("BrowserUse.activeTargetChanged", { targetId: target.targetId });
  await waitFor(() => {
    return expect(tab("Other")).toHaveAttribute("aria-selected", "true");
  });
  const admission = d.cdp.holdNextMembership("notes-tab");
  lost(d);
  await admission.received;
  await admission.release();
  await expectStreamingAt(second);
  expect(tab("Other")).toHaveAttribute("aria-selected", "true");
  await typeOn(d, "notes-tab", "Native selection");
});
test("browser-automatic-recovery-053 A delayed frame from the former selected tab cannot repaint the new one", async () => {
  const d = desktop();
  await ready(d);
  const stale = d.cdp.holdTargetFrames("main-tab");
  imageError(d);
  await stale.received;
  click(tab("Other"));
  await expectStreamingAt(second);
  const canvas = screen.getByRole("img", { name: "Live browser view" });
  const width = canvas.getAttribute("width");
  const marker = 713_091;
  const former = stale.release("%invalid-old-frame%", marker);
  await waitFor(() => {
    return expect(d.cdp.requests).toContainEqual(
      expect.objectContaining({
        method: "Page.screencastFrameAck",
        sessionId: former,
        params: { sessionId: marker },
      }),
    );
  });
  expect(canvas).toHaveAttribute("width", width);
  await expectStreamingAt(second);
  await typeOn(d, "notes-tab", "Still Other");
  expect(tab("Other")).toHaveAttribute("aria-selected", "true");
});

test.each([
  { id: "browser-automatic-recovery-030", edit: false },
  { id: "browser-automatic-recovery-031", edit: true },
])(
  "$id A recovered address submission cannot change the successor tab",
  async ({ edit }) => {
    const d = desktop();
    await ready(d);
    const user = userEvent.setup({ delay: null });
    const receipt = d.cdp.holdNext("Page.navigate");
    await fill(field(), "https://next.example");
    await user.keyboard("{Enter}");
    await receipt.received;
    const replacement = d.cdp.holdNextMembership("main-tab");
    lost(d);
    await replacement.received;
    await replacement.release();
    await expectStreamingAt("https://next.example/");
    d.cdp.move("main-tab", 202);
    await waitFor(() => {
      return expect(tab("Other")).toHaveAttribute("aria-selected", "true");
    });
    await waitFor(() => {
      return expect(input()).toBeEnabled();
    });
    const location = field();
    await user.click(location);
    expect(location).toHaveValue("https://next.example");
    if (edit) {
      await user.keyboard("{Home}x");
    }
    await user.keyboard("{Enter}");
    expect(tab("Other")).toHaveAttribute("aria-selected", "true");
    expect(
      d.cdp.targets.find((t) => {
        return t.targetId === "notes-tab";
      })?.url,
    ).toBe(second);
    expect(location).toHaveValue(
      edit ? "xhttps://next.example" : "https://next.example",
    );
  },
);

test("browser-automatic-recovery-018 A retained connection admits input only when both the refreshed descriptor and its tab are ready", async () => {
  const d = desktop();
  let elapsed = 0;
  mockMonotonicNow(() => {
    return elapsed + performance.now() * 10;
  }, context.signal);
  let revalidating = false;
  const entered = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, async ({ respond }) => {
    if (revalidating) {
      if (entered.settled()) {
        return respond(503, {
          error: {
            code: "UNAVAILABLE",
            message: "Only the retained descriptor can reopen",
          },
        });
      }
      entered.resolve();
      await release.promise;
    }
    return respond(200, { browser: d.viewer.browser, viewer: d.viewer });
  });
  try {
    await ready(d);
    const session = d.cdp.pageSession("main-tab");
    d.cdp.setAutoOpen(false);
    const replacement = d.cdp.holdTargetFrames("main-tab");
    imageError(d);
    await replacement.received;
    expect(input()).toBeDisabled();
    revalidating = true;
    refresh(d);
    await entered.promise;
    expect(input()).toBeDisabled();
    elapsed += 15_000;
    release.resolve();
    expect(input()).toBeDisabled();
    replacement.release();
    await expectStreamingAt(first);
    await typeOn(d, "main-tab", "Descriptor accepted");
    expect(
      d.cdp.requests.find((r) => {
        return r.method === "Input.insertText";
      })?.connectionId,
    ).toBe(
      d.cdp.requests.find((r) => {
        return r.sessionId === session;
      })?.connectionId,
    );
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(d.reports).toStrictEqual([]);
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
  }
});
test("browser-automatic-recovery-019 A locally edited address survives settings and retained-tab readmission during image recovery", async () => {
  const d = desktop();
  const lease = context.mocks.deferred<void>();
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    await lease.promise;
    return respond(200, { browser: d.viewer.browser });
  });
  try {
    await ready(d);
    const pending = d.cdp.holdTargetFrames("main-tab");
    imageError(d);
    await pending.received;
    d.cdp.setAutoOpen(false);
    const member = d.cdp.holdNextMembership("main-tab");
    refresh(d);
    d.cdp.duplicate("notes-tab");
    await fill(field(), "draft-to-keep.example");
    click(await findFastControl("button", "Browser settings"));
    await screen.findByText("Connection mode");
    await userEvent.setup({ delay: null }).keyboard("{Escape}");
    expect(field()).toHaveValue("draft-to-keep.example");
    await member.received;
    await member.release();
    pending.release();
    await waitFor(() => {
      return expect(input()).toBeEnabled();
    });
    expect(field()).toHaveValue("draft-to-keep.example");
    await typeOn(d, "main-tab", "After settings");
    const recovered = d.cdp.holdTargetFrames("main-tab");
    imageError(d);
    await recovered.received;
    recovered.release();
    await waitFor(() => {
      return expect(input()).toBeEnabled();
    });
    expect(d.reports).toStrictEqual([]);
  } finally {
    lease.resolve();
  }
});
test("browser-discovery-startup-023 A late first frame cannot displace the surviving tab after its owner leaves the window", async () => {
  const d = desktop(),
    pending = d.cdp.holdTargetFrames("main-tab");
  await d.openPage();
  await pending.received;
  const proof = d.cdp.holdNextMembership("main-tab");
  d.cdp.nativeEvent(
    "tab-attached",
    d.cdp.targets.find((t) => {
      return t.targetId === "main-tab";
    }),
  );
  await proof.received;
  d.cdp.move("main-tab", 202);
  await proof.release();
  await expectStreamingAt(second);
  expect(queryFastControl("tab", "Original")).toBeNull();
  const ack = 713_092;
  const original = pending.release("%stale-frame%", ack);
  await waitFor(() => {
    return expect(d.cdp.requests).toContainEqual(
      expect.objectContaining({
        method: "Page.screencastFrameAck",
        sessionId: original,
        params: { sessionId: ack },
      }),
    );
  });
  await expectStreamingAt(second);
  await typeOn(d, "notes-tab", "Later tab");
});
