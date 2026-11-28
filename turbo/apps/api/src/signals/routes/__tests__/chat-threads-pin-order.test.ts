import { randomUUID } from "node:crypto";
import {
  chatThreadPinContract,
  chatThreadPinOrderContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { chatThreadPinRoutes } from "../chat-threads-pin";
import { chatThreadPinOrderRoutes } from "../chat-threads-pin-order";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const app = setupApp({
  context,
  routes: [
    ...chatThreadCreateRoutes,
    ...chatThreadPinRoutes,
    ...chatThreadPinOrderRoutes,
  ],
});
const threadsApi = app(chatThreadsContract);
const pinApi = app(chatThreadPinContract);
const pinOrderApi = app(chatThreadPinOrderContract);

function signIn(userId: string, orgId: string) {
  createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
  return headers;
}

describe("pinned thread ordering", () => {
  it("chat-threads-pin-order-003 does not reorder an unpinned or other-org thread", async () => {
    const userId = `user_${randomUUID()}`;
    const primaryOrgId = `org_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;

    const created = await accept(
      threadsApi.create({
        headers: signIn(userId, primaryOrgId),
        body: { title: "Unpinned thread" },
      }),
      [201],
    );
    const threadId = created.body.id;

    const unpinnedReorder = await accept(
      pinOrderApi.reorder({
        headers: signIn(userId, primaryOrgId),
        params: { id: threadId },
        body: { pinOrder: "a0", eventId: randomUUID() },
      }),
      [404],
    );
    expect(unpinnedReorder.status).toBe(404);

    await accept(
      pinApi.pin({
        headers: signIn(userId, primaryOrgId),
        params: { id: threadId },
        query: { pinOrder: "a0" },
      }),
      [204],
    );

    const otherOrgReorder = await accept(
      pinOrderApi.reorder({
        headers: signIn(userId, otherOrgId),
        params: { id: threadId },
        body: { pinOrder: "a1", eventId: randomUUID() },
      }),
      [404],
    );
    expect(otherOrgReorder.status).toBe(404);
  });
});
