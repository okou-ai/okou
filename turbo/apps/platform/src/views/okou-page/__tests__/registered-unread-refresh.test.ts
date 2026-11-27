import { ApiError } from "../../../lib/api-error.ts";
import { HttpResponse } from "msw";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  setupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  installContinuityWorkspace,
  continuityThread,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

async function openUnreadHistory() {
  click(await findFastControl("button", "Open chat list menu"));
  click(
    await waitFor(() => {
      const item = queryAllByRoleFast("menuitemradio").find((element) => {
        return element.textContent?.includes("Unread");
      });
      if (!item) {
        throw new Error("Unread filter unavailable");
      }
      return item;
    }),
  );
  await screen.findByText("No unread chats");
}

async function refreshUnreadHistory(outcome: "available" | "upgrade required") {
  const title = "Field station inventory";
  const marked = continuityThread(812, 1, title);
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 812,
    threads: [marked],
  });
  const admitted = context.mocks.deferred<void>();
  const delivery = context.mocks.deferred<void>();
  let refreshing = false;
  context.mocks.http.get(
    "*" + chatThreadsContract.indicators.path,
    async () => {
      if (!refreshing) {
        return HttpResponse.json({ threads: {}, unreadAt: {} });
      }
      if (!admitted.settled()) {
        admitted.resolve();
      }
      await delivery.promise;
      if (outcome === "upgrade required") {
        return HttpResponse.json(
          {
            error: {
              message: "Inventory indicators require an upgrade",
              code: "REQUEST_FAILED",
            },
          },
          { status: 426 },
        );
      }
      return HttpResponse.json({
        threads: { [marked.id]: "unread" },
        unreadAt: { [marked.id]: marked.updatedAt },
      });
    },
  );
  await setupPage({
    ...pageOptions,
    context,
    path: "/workflows",
  });
  await openUnreadHistory();
  refreshing = true;
  const { user, organization } = pageOptions.auth;
  context.mocks.ably.triggerChannelGap(
    "user-org:" + user.id + ":" + organization?.activeOrg?.id,
  );
  try {
    await admitted.promise;
    expect(screen.getByText("No unread chats")).toBeVisible();
    expect(screen.queryByText(title)).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "Update required" }),
    ).toBeNull();
  } finally {
    delivery.resolve();
  }
  return title;
}

test("A held indicators refresh can deliver the newly unread conversation", async () => {
  const title = await refreshUnreadHistory("available");
  await expect(screen.findByText(title)).resolves.toBeVisible();
});

test("message-port-018 Unread history receives the specific API error from its indicators refresh", async () => {
  const browserErrors = vi.spyOn(console, "error");
  const title = await refreshUnreadHistory("upgrade required");
  await expect(
    screen.findByRole("dialog", { name: "Update required" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    const received = browserErrors.mock.calls
      .flat()
      .find((value: unknown): value is ApiError => {
        return (
          value instanceof ApiError &&
          value.message === "Inventory indicators require an upgrade"
        );
      });
    expect(received).toBeInstanceOf(ApiError);
    expect(received).toMatchObject({ status: 426, code: "REQUEST_FAILED" });
  });
  expect(screen.queryByText(title)).toBeNull();
});
