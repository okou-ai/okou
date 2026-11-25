import userEvent from "@testing-library/user-event";
import { initSentry } from "../../../lib/sentry.ts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockMonotonicNow } from "../../../lib/time.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
  browserTab,
} from "./browser-native-page-fixture.ts";
import { findFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
const context = testContext(),
  origin = "https://example.com",
  otherUrl = "https://other.example";
const input = () => {
  return screen.getByLabelText("Remote browser input");
};
const address = () => {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Address" });
};
function viewer(
  options: NonNullable<Parameters<typeof arrangeNativePage>[1]> = {},
) {
  mockMonotonicNow(() => {
    return performance.now() * 10;
  }, context.signal);
  return arrangeNativePage(context, {
    ...options,
    targets: [
      { targetId: "origin", title: "Original", url: origin, windowId: 101 },
      { targetId: "other", title: "Other", url: otherUrl, windowId: 101 },
    ],
  });
}
type Browser = ReturnType<typeof viewer>["cdp"];
async function typeRemote(cdp: Browser, id: string, message: string) {
  const field = input();
  field.focus();
  fireEvent.input(field, {
    target: { value: message },
    data: message,
    inputType: "insertText",
  });
  await waitFor(() => {
    return expect(cdp.inputForTarget(id)).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: message },
      }),
    );
  });
}
async function retry() {
  click(await findFastControl("button", "Reconnect"));
}
function disconnect(cdp: Browser) {
  cdp.disconnect({ code: 1006, reason: "Lost local desktop connection" });
}
test("browser-automatic-recovery-070 A name-resolution rejection is reported and later input still reaches the original document", async () => {
  const reports = context.mocks.sentry().reports;
  initSentry();
  const { openPage, cdp } = viewer();
  await openPage();
  await expectStreamingAt(origin);
  const session = cdp.pageSession("origin");
  cdp.rejectNextNavigation("net::ERR_NAME_NOT_RESOLVED");
  await fill(address(), "unreachable.example");
  click(await findFastControl("button", "Open address"));
  await waitFor(() => {
    return expect(reports).toStrictEqual([
      expect.objectContaining({
        type: "exception",
        context: expect.objectContaining({
          contexts: expect.objectContaining({
            browser_navigation: {
              method: "Page.navigate",
              reason: "net::ERR_NAME_NOT_RESOLVED",
            },
          }),
        }),
      }),
    ]);
  });
  await typeRemote(cdp, "origin", "Still here");
  expect(cdp.pageSession("origin")).toBe(session);
  expect(
    cdp.targets.find((t) => {
      return t.targetId === "origin";
    })?.url,
  ).toBe(origin);
  expect(reports).toHaveLength(1);
});
test("browser-automatic-recovery-051 Reconnect remains unavailable during a transient service failure and the restored viewer accepts input", async () => {
  const { openPage, viewer: local, cdp } = viewer();
  let status: 403 | 500 | 200 = 403;
  const held = context.mocks.deferred<void>(),
    entered = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, async ({ respond }) => {
    if (status === 200) {
      return respond(200, { browser: local.browser, viewer: local });
    }
    if (status === 500) {
      entered.resolve();
      await held.promise;
      return respond(500, {
        error: { code: "SERVER_ERROR", message: "Temporary desktop error" },
      });
    }
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Access denied" },
    });
  });
  try {
    await openPage();
    await screen.findByText("Browser view unavailable");
    status = 500;
    await retry();
    await entered.promise;
    status = 200;
    held.resolve();
    const pending = await findFastControl("button", "Reconnect");
    await waitFor(() => {
      return expect(pending).toBeDisabled();
    });
    await waitFor(() => {
      return expect(input()).toBeEnabled();
    });
    await expectStreamingAt(origin);
    await typeRemote(cdp, "origin", "Restored desktop");
  } finally {
    if (!held.settled()) {
      held.resolve();
    }
  }
});
test("browser-automatic-recovery-039 Authorization denial during recovery removes the displayed picture and leaves the viewer terminal", async () => {
  const { openPage, viewer: local, cdp } = viewer();
  let deny = false;
  const entered = context.mocks.deferred<void>(),
    hold = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, async ({ respond }) => {
    if (!deny) {
      return respond(200, { browser: local.browser, viewer: local });
    }
    if (!entered.settled()) {
      entered.resolve();
    }
    await hold.promise;
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Access withdrawn" },
    });
  });
  try {
    const diagnostics = context.mocks.sentry();
    initSentry();
    await openPage();
    await expectStreamingAt(origin);
    deny = true;
    disconnect(cdp);
    await entered.promise;
    expect(
      screen.getByRole("img", { name: "Live browser view" }),
    ).toBeInTheDocument();
    hold.resolve();
    await screen.findByText("Browser view unavailable");
    expect(input()).toBeDisabled();
    expect(screen.queryByRole("img", { name: "Live browser view" })).toBeNull();
    expect(screen.queryByText(/Reconnecting…/u)).toBeNull();
    expect(diagnostics.reports).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          contexts: expect.objectContaining({
            browser_recovery: { outcome: "terminal" },
          }),
        }),
      }),
    );
    await expect(findFastControl("button", "Reconnect")).resolves.toBeEnabled();
  } finally {
    if (!hold.settled()) {
      hold.resolve();
    }
  }
});
test("browser-automatic-recovery-032 An address entered before tab admission can be submitted once its page becomes ready", async () => {
  const { openPage, cdp } = viewer();
  await openPage();
  await expectStreamingAt(origin);
  const membership = cdp.holdNextMembership("origin");
  disconnect(cdp);
  await membership.received;
  const location = address();
  await fill(location, "resumed.example");
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Enter}");
  expect(input()).toBeDisabled();
  await membership.release();
  await waitFor(() => {
    return expect(input()).toBeEnabled();
  });
  expect(browserTab("Original")).toHaveAttribute("aria-selected", "true");
  expect(location).toHaveFocus();
  expect(location).toHaveValue("resumed.example");
  await user.keyboard("{Enter}");
  await waitFor(() => {
    return expect(
      cdp.targets.find((t) => {
        return t.targetId === "origin";
      })?.url,
    ).toBe("http://resumed.example/");
  });
});

function changingWindow() {
  const page = viewer();
  let windowId = 101;
  let waiting = false;
  const entered = context.mocks.deferred<void>(),
    allow = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, async ({ respond }) => {
    if (waiting) {
      if (!entered.settled()) {
        entered.resolve();
      }
      await allow.promise;
    }
    const browser = {
      ...page.viewer.browser,
      window: {
        instanceId: "a0000000-0000-4000-a000-000000000872",
        primaryWindowId: windowId,
      },
    };
    return respond(200, { browser, viewer: { ...page.viewer, browser } });
  });
  return {
    ...page,
    async loseConnection() {
      waiting = true;
      disconnect(page.cdp);
      await entered.promise;
    },
    resume(replaced: boolean) {
      if (replaced) {
        page.cdp.move("other", 202);
        windowId = 202;
      }
      allow.resolve();
    },
  };
}
async function editDuringRecovery(switched: boolean) {
  const { openPage, cdp, loseConnection, resume } = changingWindow();
  await openPage();
  await expectStreamingAt(origin);
  const field = address();
  const user = userEvent.setup({ delay: null });
  await fill(field, "my.example");
  field.setSelectionRange(2, 2);
  await loseConnection();
  await user.keyboard("x");
  expect(field.value).toBe("myx.example");
  expect(field.selectionStart).toBe(3);
  resume(switched);
  await waitFor(() => {
    return expect(input()).toBeEnabled();
  });
  expect(field).toHaveFocus();
  expect(field).toHaveValue("myx.example");
  expect([field.selectionStart, field.selectionEnd]).toStrictEqual([3, 3]);
  return { field, user, cdp };
}
test("browser-automatic-recovery-026 The draft and caret survive reconnection and submit to the same window", async () => {
  const { field, user, cdp } = await editDuringRecovery(false);
  await user.keyboard("{Enter}");
  await waitFor(() => {
    return expect(
      cdp.targets.find((t) => {
        return t.targetId === "origin";
      })?.url,
    ).toBe("http://myx.example/");
  });
  cdp.move("origin", 202);
  await waitFor(() => {
    return expect(browserTab("Other")).toHaveAttribute("aria-selected", "true");
  });
  field.focus();
  await user.keyboard("{Escape}");
  expect(field).toHaveValue(otherUrl);
});
test("browser-automatic-recovery-027 The replaced window retains its draft and caret but cannot submit the detached address", async () => {
  const { field, user, cdp } = await editDuringRecovery(true);
  expect(browserTab("Other")).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Enter}");
  await expect(
    findFastControl("button", "Open address"),
  ).resolves.toBeDisabled();
  expect(
    cdp.targets.map((t) => {
      return t.url;
    }),
  ).toStrictEqual([origin, otherUrl]);
  await user.keyboard("{Escape}");
  expect(field).toHaveValue(otherUrl);
});

test("browser-automatic-recovery-028 Blur adopts the replacement tab after the focused original address and caret survive recovery", async () => {
  const { openPage, cdp, loseConnection, resume } = changingWindow();
  await openPage();
  await expectStreamingAt(origin);
  const location = address();
  const user = userEvent.setup({ delay: null });
  await user.click(location);
  location.setSelectionRange(2, 2);
  await loseConnection();
  resume(true);
  await waitFor(() => {
    return expect(browserTab("Other")).toHaveAttribute("aria-selected", "true");
  });
  await waitFor(() => {
    return expect(input()).toBeEnabled();
  });
  expect(location).toHaveFocus();
  expect(location.value).toBe(origin);
  expect([location.selectionStart, location.selectionEnd]).toStrictEqual([
    2, 2,
  ]);
  location.blur();
  await waitFor(() => {
    expect(location).toHaveValue(otherUrl);
  });
  await fill(location, "new-place.example");
  await user.keyboard("{Enter}");
  await waitFor(() => {
    return expect(
      cdp.targets.find((t) => {
        return t.targetId === "other";
      })?.url,
    ).toBe("http://new-place.example/");
  });
  expect(
    cdp.targets.find((t) => {
      return t.targetId === "origin";
    })?.url,
  ).toBe(origin);
});

test("browser-automatic-recovery-059 Reconnection adopts the completed remote navigation without replaying the uncertain submission", async () => {
  const { openPage, cdp } = viewer();
  const reports = context.mocks.sentry().reports;
  initSentry();
  mockMonotonicNow(() => {
    return performance.now() * 10;
  }, context.signal);
  await openPage();
  await expectStreamingAt(origin);
  const receipt = cdp.holdNext("Page.navigate");
  await fill(address(), "https://next.example");
  click(await findFastControl("button", "Open address"));
  await receipt.received;
  expect(
    cdp.targets.find((t) => {
      return t.targetId === "origin";
    })?.url,
  ).toBe("https://next.example/");
  cdp.redirectNextNavigation("https://would-have-replayed.example/");
  const admission = cdp.holdNextMembership("origin");
  disconnect(cdp);
  await admission.received;
  await admission.release();
  await expectStreamingAt("https://next.example/");
  await typeRemote(cdp, "origin", "Fresh text");
  expect(
    cdp.targets.find((t) => {
      return t.targetId === "origin";
    })?.url,
  ).toBe("https://next.example/");
  expect(reports).toStrictEqual([]);
});
