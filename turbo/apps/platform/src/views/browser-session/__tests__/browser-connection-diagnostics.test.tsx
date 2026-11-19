import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { fill } from "../../../__tests__/page-helper.ts";
import { setupSentryLogger } from "../../../lib/sentry-config.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
const home = "https://example.com";
const privateProviderDetail = "https://private.example.test/session-token";
const destination = "https://next.example.test/";

function observeExceptions() {
  const sentry = context.mocks.sentry();
  setupSentryLogger();
  return () => {
    return sentry.reports.filter((report) => {
      return report.type === "exception";
    });
  };
}

async function submitAddress(url: string) {
  const address = screen.getByLabelText("Address");
  await fill(address, url);
  await userEvent.setup({ delay: null }).keyboard("{Enter}");
}

test("Report only safe native startup facts when the bridge cannot bind", async () => {
  const reports = observeExceptions();
  const { cdp, openPage } = arrangeNativePage(context);
  cdp.failNext("Runtime.addBinding", privateProviderDetail, -32001);

  await openPage();

  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(reports()).toHaveLength(1);
    expect(
      screen.queryByRole("img", { name: "Live browser view" }),
    ).not.toBeInTheDocument();
  });
  const [report] = reports();
  expect(report).toMatchObject({
    context: {
      tags: { browser_event: "recovery-stopped" },
      contexts: {
        browser_bridge: {
          stage: "bind-events",
          reason: "cdp-protocol-failed",
          request: { method: "Runtime.addBinding", code: -32001 },
        },
      },
    },
  });
  expect(String(report?.error)).not.toContain(privateProviderDetail);
  expect(JSON.stringify(report)).not.toContain(privateProviderDetail);
  expect(JSON.stringify(report)).not.toContain("wss://cdp.example.test");
});

test("Reuse the same opening native connection through revalidation without reporting cancellation", async () => {
  const reports = observeExceptions();
  const { cdp, viewer, openPage } = arrangeNativePage(context, {
    autoOpen: false,
  });
  let reads = 0;
  const revalidated = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, ({ respond }) => {
    reads += 1;
    if (reads === 2) {
      revalidated.resolve();
    }
    return respond(200, { browser: viewer.browser, viewer });
  });
  await openPage();
  await waitFor(() => {
    expect(cdp.connections()).toBe(1);
    expect(
      context.mocks.ably.hasSubscription("browserSessionChanged"),
    ).toBeTruthy();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();

  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: viewer.browser.threadId,
  });
  await revalidated.promise;
  cdp.openConnection();

  await expectStreamingAt(home);
  expect(cdp.connections()).toBe(1);
  expect(reports()).toHaveLength(0);
});

test("Keep the selected page usable after a handled background lookup rejection", async () => {
  const reports = observeExceptions();
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(home);
  const duplicateMembership = cdp.holdNextMembership("created-1");
  cdp.duplicate("example-page");
  await duplicateMembership.received;
  await duplicateMembership.releaseFailure();

  await submitAddress(destination);

  await expectStreamingAt(destination);
  expect(reports()).toHaveLength(0);
});

test.each([
  { label: "native abort token with private text", method: "native" },
  { label: "provider request failure", method: "request" },
])("Report safe navigation diagnostics for a $label", async ({ method }) => {
  const reports = observeExceptions();
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(home);
  if (method === "native") {
    cdp.rejectNextNavigation(`net::ERR_ABORTED ${privateProviderDetail}`);
  } else {
    cdp.failNext("Page.navigate", privateProviderDetail, -32001);
  }

  await submitAddress("https://rejected.example.test/");

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("The browser action could not be completed");
  await waitFor(() => {
    expect(reports()).toHaveLength(1);
  });
  const [report] = reports();
  if (method === "native") {
    expect(report?.context).toMatchObject({
      contexts: {
        browser_navigation: { method: "Page.navigate", reason: "unknown" },
      },
    });
  } else {
    expect(report?.error).toMatchObject({
      cause: {
        kind: "protocol",
        request: { method: "Page.navigate", code: -32001 },
      },
    });
  }
  expect(String(report?.error)).not.toContain(privateProviderDetail);
  if (report?.error instanceof Error) {
    expect(String(report.error.cause)).not.toContain(privateProviderDetail);
  }
  expect(JSON.stringify(report)).not.toContain(privateProviderDetail);
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  await submitAddress(destination);
  await expectStreamingAt(destination);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(reports()).toHaveLength(1);
});
