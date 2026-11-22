import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { observeWorkerTraffic } from "./worker-traffic-fixture.ts";

const context = testContext();

test.each([
  [
    "message-port-017",
    chatThreadsContract.snapshot.path,
    "SharedDatabaseHttpError",
  ],
  ["message-port-018", chatThreadsContract.indicators.path, "ApiError"],
] as const)(
  "%s A failed workspace read retains its error at the page's worker boundary",
  async (_id, path, name) => {
    const traffic = observeWorkerTraffic(context.signal);
    const sent = context.mocks.deferred<void>();
    const respond = context.mocks.deferred<void>();
    context.mocks.http.get("*" + path, async () => {
      sent.resolve();
      await respond.promise;
      return HttpResponse.json(
        {
          error: {
            code: "REQUEST_FAILED",
            message: "Local response unavailable",
          },
        },
        { status: 426 },
      );
    });
    const page = await startPage({
      context,
      path: "/workflows",
      sharedWorkerTestTransport: "message-port",
    });
    await page.content;
    await sent.promise;
    expect(
      screen.queryByRole("dialog", { name: "Update required" }),
    ).toBeNull();
    respond.resolve();
    await expect(
      screen.findByRole("dialog", { name: "Update required" }),
    ).resolves.toBeVisible();
    await waitFor(() => {
      const requests = new Set(
        traffic.requests().flatMap((message) => {
          if (
            message.type === "query" &&
            message.query.dataKey.kind === "chat-thread-event" &&
            message.query.consistency === "catch-up" &&
            name === "SharedDatabaseHttpError"
          ) {
            return [message.requestId];
          }
          if (
            message.type === "get-computed" &&
            message.computedKey === "chat-thread-indicators" &&
            name === "ApiError"
          ) {
            return [message.requestId];
          }
          return [];
        }),
      );
      const failures = traffic.received().flatMap((message) => {
        return message.type === "error" && requests.has(message.requestId)
          ? [message.error]
          : [];
      });
      expect(failures).toContainEqual(
        expect.objectContaining(
          name === "ApiError"
            ? { name, status: 426, code: "REQUEST_FAILED" }
            : { name, status: 426 },
        ),
      );
    });
  },
);
