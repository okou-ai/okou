import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { mockMonotonicNow } from "../../../lib/time.ts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  cachedChatListEvents,
  chatListEvent,
  chatListThread,
  installChatListStream,
} from "../../okou-page/__tests__/chat-list-test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { arrangeNativePage } from "./browser-native-page-fixture.ts";

const context = testContext();
const address = "https://owned.example";
const denied = "Cloud browser is not enabled for this chat";
function browserService(initial: "active" | "suspended") {
  const nextEndpoint = "wss://replacement.example.test/devtools";
  const page = arrangeNativePage(context, {
    endpointAliases: [nextEndpoint],
    targets: [
      { windowId: 101, targetId: "first", title: "Original", url: address },
      { windowId: 202, targetId: "second", title: "Replacement", url: address },
    ],
  });
  const { window: originalWindow, ...session } = page.viewer.browser;
  const replacement = {
    ...page.viewer,
    cdpUrl: nextEndpoint,
    browser: {
      ...session,
      window: {
        ...originalWindow,
        primaryWindowId: 202,
        instanceId: "adc3e220-89e7-4dc0-87c5-e0833c247d5e",
      },
    },
  };
  const blocked = context.mocks.deferred<void>();
  const service = {
    state: initial as
      "active" | "suspended" | "stalled" | "revoked" | "renewed",
    onStart: undefined as ((operationId: string) => void) | undefined,
    operationId: "",
    notify(operationId?: string) {
      context.mocks.ably.trigger("browserSessionChanged", {
        threadId: session.threadId,
        ...(operationId ? { operationId } : {}),
      });
    },
  };
  context.mocks.api(browserContract.get, async ({ respond }) => {
    if (service.state === "stalled") {
      await blocked.promise;
    }
    if (service.state === "revoked") {
      return respond(403, {
        error: {
          code: "BROWSER_AUTHORIZATION_REQUIRED",
          message: "Browser permission required",
        },
      });
    }
    if (service.state === "suspended") {
      return respond(200, {
        browser: {
          ...session,
          status: "suspended",
          suspendedAt: session.createdAt,
        },
        viewer: null,
      });
    }
    const viewer = service.state === "renewed" ? replacement : page.viewer;
    return respond(200, { browser: viewer.browser, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, {
      browser:
        service.state === "renewed" ? replacement.browser : page.viewer.browser,
    });
  });
  context.mocks.api(browserContract.open, ({ body, respond }) => {
    if (!service.onStart) {
      return respond(503, {
        error: { code: "UNAVAILABLE", message: "Start unavailable" },
      });
    }
    if (!body.operationId) {
      return respond(400, {
        error: {
          code: "BAD_REQUEST",
          message: "Expected a viewer Start operation",
        },
      });
    }
    service.operationId = body.operationId;
    service.onStart(service.operationId);
    return respond(200, { browser: page.viewer.browser, viewer: page.viewer });
  });
  async function submit(targetId: string, text: string) {
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    const input = screen.getByLabelText("Remote browser input");
    expect(
      screen.getByRole("img", { name: "Live browser view" }),
    ).toBeVisible();
    input.focus();
    fireEvent.input(input, {
      target: { value: text },
      inputType: "insertText",
      data: text,
    });
    await waitFor(() => {
      expect(page.cdp.input).toContainEqual(
        expect.objectContaining({
          method: "Input.insertText",
          params: { text },
          sessionId: page.cdp.pageSession(targetId),
        }),
      );
    });
  }
  async function start() {
    await page.openPage();
    click(await screen.findByText("Start browser", { selector: "button" }));
  }
  return { service, page, submit, start };
}
test.each([
  { id: "002", echo: false },
  { id: "003", echo: true },
])(
  "browser-viewer-acquisition-$id uses the Start connection while later acquisitions are held",
  async ({ echo }) => {
    const { service, start, submit } = browserService("suspended");
    service.onStart = (id) => {
      service.state = "stalled";
      if (echo) {
        service.notify(id);
      }
    };
    await start();
    await submit("first", "Write from the started browser");
    expect(screen.getByLabelText("Address")).toHaveValue(address);
  },
);
test("browser-viewer-acquisition-007 reacquires input after an unrelated event retires the Start operation", async () => {
  const { service, start, submit } = browserService("suspended");
  service.onStart = () => {
    service.state = "revoked";
    service.notify();
  };
  await start();
  await screen.findByText(denied);
  service.state = "renewed";
  service.onStart = undefined;
  service.notify(service.operationId);
  await submit("second", "Back after permission was restored");
  expect(screen.getByLabelText("Address")).toHaveValue(address);
});
test("browser-viewer-acquisition-008 reconnects the disconnected browser on its replacement binding", async () => {
  let elapsed = 0;
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  const { service, page, submit } = browserService("active");
  await page.openPage();
  await submit("first", "Before disconnection");
  service.state = "renewed";
  page.cdp.disconnect({ code: 1006, wasClean: false });
  await screen.findByText("Reconnecting…");
  elapsed += 1000;
  await submit("second", "After reconnect");
  expect(screen.getByLabelText("Address")).toHaveValue(address);
});
test("browser-viewer-acquisition-009 obtains a fresh input destination after permission returns", async () => {
  const { service, page, submit } = browserService("suspended");
  const threadId = page.viewer.browser.threadId;
  const snapshot = [
    chatListThread(36, "Authorized workspace", {
      id: threadId,
      cloudBrowserEnabled: true,
    }),
  ];
  const stream = installChatListStream(context, { caseId: 36, snapshot });
  const revoke = chatListEvent(36, 2, "computer_use_host_updated", threadId, {
    cloudBrowserEnabled: false,
  });
  const renew = chatListEvent(36, 3, "computer_use_host_updated", threadId, {
    cloudBrowserEnabled: true,
  });
  service.onStart = () => {
    service.state = "active";
  };
  await setupPage({
    context,
    path: "/browsers/" + threadId,
    cachedChatThreadEvents: cachedChatListEvents(36, snapshot),
  });
  click(await screen.findByText("Start browser", { selector: "button" }));
  await submit("first", "Before revocation");
  service.state = "revoked";
  stream.setEvents([revoke]);
  context.mocks.ably.trigger("threadListChanged");
  await screen.findByText(denied);
  service.onStart = undefined;
  service.state = "renewed";
  stream.setEvents([revoke, renew]);
  context.mocks.ably.trigger("threadListChanged");
  await submit("second", "Newly authorized");
  expect(screen.getByLabelText("Address")).toHaveValue(address);
});
