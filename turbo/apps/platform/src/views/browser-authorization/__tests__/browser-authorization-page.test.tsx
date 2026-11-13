import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { mockAuthorizationCallbackThread } from "../../okou-page/__tests__/authorization-callback-test-helpers.ts";
import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { platformOkouWordmarkDarkImg } from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const REQUEST_TOKEN = "browser-request-token";

function mockPendingAuthorization(): void {
  context.mocks.api(browserAuthorizationRequestsContract.get, ({ respond }) => {
    return respond(200, {
      id: "a0000000-0000-4000-a000-000000000001",
      chatThreadId: "b0000000-0000-4000-a000-000000000001",
      expiresAt: "2099-09-01T10:00:00.000Z",
      completedAt: null,
      cloudBrowserEnabled: false,
    });
  });
}

function getButton(name: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

test("Cloud-browser authorization uses the current app's brand", async () => {
  context.mocks.browser.matchMedia(false);
  mockPendingAuthorization();

  await setupPage({
    context,
    path: `/browser/authorize/${REQUEST_TOKEN}`,
    host: "app.okou.ai",
  });

  await expect(
    screen.findByRole("heading", { name: "Enable cloud browser" }),
  ).resolves.toBeVisible();
  const brandLink = queryAllByRoleFast("link").find((candidate) => {
    return candidate.querySelector('img[alt="Okou"]') !== null;
  });
  if (!brandLink) {
    throw new Error("Expected the Okou brand link");
  }
  expect(brandLink).toHaveAttribute("href", "/connectors");
  expect(screen.getByRole("img", { name: "Okou" })).toHaveAttribute(
    "src",
    platformOkouWordmarkDarkImg,
  );
});

test("A user can enable the cloud browser for one conversation", async () => {
  let applyCount = 0;
  mockPendingAuthorization();
  context.mocks.api(
    browserAuthorizationRequestsContract.apply,
    ({ params, respond }) => {
      if (params.requestToken === REQUEST_TOKEN) {
        applyCount += 1;
      }
      return respond(200, { ok: true, cloudBrowserEnabled: true });
    },
  );

  await setupPage({
    context,
    path: `/browser/authorize/${REQUEST_TOKEN}`,
  });

  await expect(
    screen.findByRole("heading", { name: "Enable cloud browser" }),
  ).resolves.toBeVisible();
  expect(
    screen.getByText(
      "Okou uses the same website logins across chats, with a separate browser window and tabs for each chat. Enabling Browser disconnects Computer Use for this chat.",
    ),
  ).toBeVisible();
  click(getButton("Enable for this thread"));

  await waitFor(() => {
    expect(getButton("Cloud browser enabled")).toBeDisabled();
  });
  expect(applyCount).toBe(1);
});

test.each([false, true])(
  "The standalone Browser page honors the optional callback (%s)",
  async (callback) => {
    const threadId = "b0000000-0000-4000-a000-000000000001";
    mockPendingAuthorization();
    mockAuthorizationCallbackThread(context, threadId);
    let grants = 0;
    const prompts: string[] = [];
    context.mocks.api(
      browserAuthorizationRequestsContract.apply,
      ({ respond }) => {
        grants++;
        return respond(200, { ok: true, cloudBrowserEnabled: true });
      },
    );
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      expect(grants).toBe(1);
      expect(body.clientEventId).toBe("a0000000-0000-4000-a000-000000000001");
      if (body.prompt) {
        prompts.push(body.prompt);
      }
      return respond(201, { threadId });
    });
    await setupPage({
      context,
      path: `/browser/authorize/${REQUEST_TOKEN}${callback ? `?threadId=${threadId}&callbackPrompt=Continue` : ""}`,
      host: "app.okou.ai",
    });
    await waitFor(() => {
      expect(getButton("Enable for this thread")).toBeEnabled();
    });
    click(getButton("Enable for this thread"));
    await waitFor(() => {
      expect(getButton("Cloud browser enabled")).toBeDisabled();
    });
    expect(grants).toBe(1);
    expect(prompts).toStrictEqual(callback ? ["Continue"] : []);
  },
);
