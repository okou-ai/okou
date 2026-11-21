import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
} from "../../okou-page/__tests__/chat-run-test-fixtures.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
function observeDiagnostics() {
  const destination = context.mocks.sentry();
  initSentry();
  return destination;
}
function submit(url: string) {
  fireEvent.change(screen.getByLabelText("Address"), {
    target: { value: url },
  });
  click(screen.getByLabelText("Open address"));
}

// Include the normally non-enumerable Error details when checking the external report.
function reportText(report: unknown) {
  return JSON.stringify(report, (_key, value: unknown) => {
    if (value instanceof Error) {
      return {
        ...value,
        message: value.message,
        stack: value.stack,
        cause: value.cause,
      };
    }
    return value;
  });
}

test("browser-connection-diagnostics-01 event binding refusal disables the viewer and reports sanitized startup attribution", async () => {
  const telemetry = observeDiagnostics();
  const { cdp, viewer, openPage } = arrangeNativePage(context);
  const privateWorker = "worker-secret-758";
  cdp.failNext(
    "Runtime.addBinding",
    privateWorker + " at " + viewer.cdpUrl,
    -32_603,
  );
  await openPage();
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await waitFor(() => {
    expect(telemetry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        context: expect.objectContaining({
          contexts: expect.objectContaining({
            browser_bridge: expect.objectContaining({
              stage: "bind-events",
              request: { method: "Runtime.addBinding", code: -32_603 },
            }),
          }),
        }),
      }),
    );
  });
  const worker = cdp.requests.find((entry) => {
    return entry.method === "Runtime.addBinding";
  })?.sessionId;
  if (!worker) {
    throw new Error("Expected a worker session for the failed native binding");
  }
  const external = reportText(telemetry.reports);
  for (const sensitive of [
    privateWorker,
    viewer.cdpUrl,
    worker,
    "okou-worker",
    viewer.extension.runtimeId,
  ]) {
    expect(external).not.toContain(sensitive);
  }
});

test("browser-connection-diagnostics-02 refreshed session details admit input through the original pending native socket", async () => {
  const telemetry = observeDiagnostics();
  const first = context.mocks.deferred<{ open(): void }>();
  const nativeSockets = new Set<{ open(): void }>();
  const page = arrangeNativePage(context, {
    autoOpen: false,
    onConnecting: (_url, socket) => {
      nativeSockets.add(socket);
      if (!first.settled()) {
        first.resolve(socket);
      }
    },
  });
  const { browser } = page.viewer;
  const runId = "b0000000-0000-4000-a000-000000000803";
  createChatRunFixtures(context).installRunChat({
    threadId: browser.threadId,
    cloudBrowserEnabled: true,
    chatEvents: [
      assistantEvent({
        id: "session-card",
        runId,
        seqId: 1,
        text: browser.viewerUrl,
      }),
      completedEvent({ id: "plan-complete", runId, seqId: 2 }),
    ],
  });
  let details = browser;
  function snapshot() {
    return { browser: details, viewer: { ...page.viewer, browser: details } };
  }
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, snapshot());
  });
  context.mocks.api(browserContract.open, ({ respond }) => {
    return respond(200, snapshot());
  });
  // Only the lifecycle refresh can supply the new card label during this check.
  const heartbeat = context.mocks.deferred<void>();
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    await heartbeat.promise;
    return respond(200, { browser });
  });
  await setupPage({
    context,
    path: "/chats/" + browser.threadId,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
  });
  const card = await screen.findByLabelText("Open Shared browser browser");
  const beforeOpening = [...telemetry.reports];
  click(card);
  const original = await first.promise;
  details = { ...browser, name: "Refreshed plan" };
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: browser.threadId,
  });
  await screen.findByLabelText("Open Refreshed plan browser");
  const input = screen.getByLabelText("Remote browser input");
  expect(input).toBeDisabled();
  await act(() => {
    original.open();
  });
  await expectStreamingAt("https://example.com");
  const text = "Continue session";
  input.focus();
  fireEvent.input(input, {
    data: text,
    inputType: "insertText",
    target: { value: text },
  });
  await waitFor(() => {
    expect(page.cdp.input).toContainEqual({
      sessionId: page.cdp.pageSession("example-page"),
      method: "Input.insertText",
      params: { text },
    });
  });
  expect(nativeSockets).toStrictEqual(new Set([original]));
  expect(telemetry.reports).toStrictEqual(beforeOpening);
});

test("browser-connection-diagnostics-03 a failed duplicate-page lookup leaves the selected document navigable without an exception", async () => {
  const telemetry = observeDiagnostics();
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt("https://example.com");
  const beforeLookup = [...telemetry.reports];
  cdp.duplicate("example-page");
  const copy = await screen.findByLabelText(/.+/, {
    selector: '[role="tab"][aria-selected="false"]',
  });
  const duplicate = cdp.holdNextMembership("created-1");
  cdp.nativeEvent(
    "tab-attached",
    cdp.targets.find((target) => {
      return target.targetId === "created-1";
    }),
  );
  await duplicate.received;
  expect(copy).toBeInTheDocument();
  await act(() => {
    return duplicate.releaseFailure("Duplicate page vanished");
  });
  await waitFor(() => {
    expect(
      screen.queryByLabelText(/.+/, {
        selector: '[role="tab"][aria-selected="false"]',
      }),
    ).not.toBeInTheDocument();
  });
  const destination = "https://maps.example/selected";
  submit(destination);
  await screen.findByLabelText("maps.example", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  await expectStreamingAt(destination);
  expect(cdp.targets).toContainEqual(
    expect.objectContaining({ targetId: "example-page", url: destination }),
  );
  expect(telemetry.reports).toStrictEqual(beforeLookup);
});

test("browser-connection-diagnostics-05.03 a decorated abort token reports unknown and the next destination clears the notice", async () => {
  const telemetry = observeDiagnostics();
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt("https://example.com");
  const privateUrl = "https://internal.example/notes?access=private-418";
  cdp.rejectNextNavigation("net::ERR_ABORTED " + privateUrl);
  submit(privateUrl);
  const notice = await screen.findByText(
    /browser action could not be completed/i,
  );
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  await waitFor(() => {
    expect(telemetry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        context: expect.objectContaining({
          contexts: expect.objectContaining({
            browser_navigation: { method: "Page.navigate", reason: "unknown" },
          }),
        }),
      }),
    );
  });
  submit("https://public.example/start");
  await screen.findByLabelText("public.example", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  await expectStreamingAt("https://public.example/start");
  expect(notice).not.toBeInTheDocument();
  const errors = telemetry.reports.filter((event) => {
    return event.type === "exception";
  });
  expect(errors).toHaveLength(1);
  expect(reportText(errors)).not.toContain("internal.example");
  expect(reportText(errors)).not.toContain("private-418");
});
