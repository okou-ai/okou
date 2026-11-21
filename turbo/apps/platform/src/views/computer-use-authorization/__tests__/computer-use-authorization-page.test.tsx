import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import {
  computerUseAuthorizationRequestsContract,
  type ComputerUseHost,
} from "@okouai/api-contracts/contracts/computer-use";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { onlineComputerUseHost } from "../../okou-page/__tests__/chat-list-test-helpers.ts";

const context = testContext();
const REQUEST_TOKEN = "cu-request-token-4410";
const STUDIO_MAC = "f0000000-0000-4000-8000-000000000001";

function mockAuthorizationRequest(hosts: ComputerUseHost[]): {
  appliedHostId?: string;
} {
  const applied: { appliedHostId?: string } = {};
  context.mocks.api(
    computerUseAuthorizationRequestsContract.get,
    ({ respond }) => {
      return respond(200, {
        id: "a3000000-0000-4000-8000-000000000001",
        source: "chat",
        chatThreadId: null,
        expiresAt: "2099-01-01T00:00:00.000Z",
        completedAt: applied.appliedHostId ? "2026-11-20T08:00:00.000Z" : null,
        computerUseHostId: applied.appliedHostId ?? null,
        hosts,
      });
    },
  );
  context.mocks.api(
    computerUseAuthorizationRequestsContract.apply,
    ({ body, respond }) => {
      applied.appliedHostId = body.computerUseHostId;
      return respond(200, {
        ok: true,
        source: "chat",
        computerUseHostId: body.computerUseHostId,
      });
    },
  );
  return applied;
}

function button(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
}

test("A user with no online computer receives setup guidance", async () => {
  mockAuthorizationRequest([
    { ...onlineComputerUseHost(STUDIO_MAC, "Studio Mac"), status: "offline" },
  ]);

  await setupPage({
    context,
    path: `/computer-use/authorize/${REQUEST_TOKEN}`,
  });

  await expect(
    screen.findByRole("heading", { name: "No online computers" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Open Okou on your Mac to bring it online."),
  ).toBeInTheDocument();
  expect(screen.queryByText("Studio Mac")).not.toBeInTheDocument();
  const download = await waitFor(() => {
    const link = queryAllByRoleFast("link").find((candidate) => {
      return candidate.textContent?.trim() === "Download for macOS";
    });
    if (!link) {
      throw new Error("Expected the macOS download link");
    }
    return link;
  });
  expect(new URL(download.getAttribute("href") ?? "").pathname).toBe(
    "/api/desktop/updates/stable/darwin/arm64/dmg",
  );
});

test("The standalone computer page honors the optional callback (false)", async () => {
  const request = mockAuthorizationRequest([
    onlineComputerUseHost(STUDIO_MAC, "Studio Mac"),
  ]);
  const callback: { prompt?: string } = {};
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    callback.prompt = body.prompt;
    return respond(500, {
      error: { code: "UNEXPECTED_CALLBACK", message: "No callback expected" },
    });
  });
  await setupPage({
    context,
    path: `/computer-use/authorize/${REQUEST_TOKEN}`,
  });
  await expect(screen.findByText("Studio Mac")).resolves.toBeInTheDocument();
  const authorize = await waitFor(() => {
    const found = button("Authorize");
    expect(found).toBeEnabled();
    return found as HTMLElement;
  });

  click(authorize);

  await waitFor(() => {
    expect(button("Authorized")).toBeDisabled();
  });
  expect(request.appliedHostId).toBe(STUDIO_MAC);
  expect(button("Authorize")).toBeUndefined();
  // Without a callback thread or prompt, nothing is posted to a chat.
  expect(callback.prompt).toBeUndefined();
});
