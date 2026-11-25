import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/browser";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const REQUEST_TOKEN = "vm0_browser_authorization_request_test";
const THREAD_ID = "b0000000-0000-4000-a000-000000000951";
const PAGE_PATH = `/browser/authorize/${REQUEST_TOKEN}`;

/** The pending request as the API stores it; applying it completes it. */
function mockPendingRequest(): void {
  const server = { applied: false };
  context.mocks.api(browserAuthorizationRequestsContract.get, ({ respond }) => {
    return respond(200, {
      id: "a4000000-0000-4000-8000-000000000001",
      chatThreadId: THREAD_ID,
      expiresAt: "2099-01-01T00:00:00.000Z",
      completedAt: server.applied ? "2026-11-20T08:00:00.000Z" : null,
      cloudBrowserEnabled: server.applied,
    });
  });
  context.mocks.api(
    browserAuthorizationRequestsContract.apply,
    ({ respond }) => {
      server.applied = true;
      return respond(200, { ok: true, cloudBrowserEnabled: true });
    },
  );
}

function button(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
}

async function enableForThread(): Promise<void> {
  const enable = await waitFor(() => {
    const found = button("Enable for this thread");
    expect(found).toBeEnabled();
    return found as HTMLElement;
  });
  click(enable);
  await waitFor(() => {
    expect(button("Cloud browser enabled")).toBeDisabled();
  });
}

test.each([404])(
  "An unavailable authorization link does not offer browser access (%i)",
  async (status) => {
    context.mocks.api(
      browserAuthorizationRequestsContract.get,
      ({ respond }) => {
        return respond(status, {
          error: { code: "NOT_FOUND", message: "Authorization not found" },
        });
      },
    );

    await setupPage({ context, path: PAGE_PATH });

    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "This cloud browser authorization link is invalid, expired, or not available for this workspace.",
    );
    const brand = queryAllByRoleFast("link").find((link) => {
      return link.getAttribute("href") === "/connectors";
    });
    expect(brand).toBeDefined();
    expect(queryAllByRoleFast("button")).toStrictEqual([]);
  },
);

test("A user can enable the cloud browser for one conversation", async () => {
  mockPendingRequest();
  await setupPage({ context, path: PAGE_PATH });
  await expect(
    screen.findByRole("heading", { name: "Enable cloud browser" }),
  ).resolves.toBeInTheDocument();

  await enableForThread();

  expect(button("Enable for this thread")).toBeUndefined();
});

test("The standalone Browser page honors the optional callback (false)", async () => {
  mockPendingRequest();
  const callback: { prompt?: string } = {};
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    callback.prompt = body.prompt;
    return respond(500, {
      error: { code: "UNEXPECTED_CALLBACK", message: "No callback expected" },
    });
  });
  await setupPage({ context, path: PAGE_PATH });

  await enableForThread();

  // Without a callback thread or prompt, nothing is posted to a chat.
  expect(callback.prompt).toBeUndefined();
});
