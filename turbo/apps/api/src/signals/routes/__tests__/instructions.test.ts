import { randomUUID } from "node:crypto";

import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { SINGLE_AGENT_SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { instructionsRoutes } from "../instructions";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { countPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import { now } from "../../../lib/time";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Member {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
}

/**
 * A workspace member identity, by default in a fresh workspace. `join` seeds
 * its Clerk membership and `signIn` gives it the Clerk session of a request.
 */
function member(
  orgId = `org_${randomUUID()}`,
  role: Member["role"] = "member",
  userId = `user_${randomUUID()}`,
): Member {
  return { userId, orgId, role };
}

async function join(...members: readonly Member[]) {
  const store = createStore();
  for (const each of members) {
    await store.set(
      seedOrgMembership$,
      { orgId: each.orgId, userId: each.userId, role: each.role },
      context.signal,
    );
  }
}

function signIn(actor: Member) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role === "admin" ? "org:admin" : "org:member",
  );
}

function client() {
  return setupApp({ context, routes: instructionsRoutes })(
    instructionsContract,
  );
}

async function read(actor: Member) {
  signIn(actor);
  const response = await accept(client().get({ headers }), [200]);
  return response.body;
}

async function save(actor: Member, content: string) {
  signIn(actor);
  const response = await accept(
    client().update({ headers, body: { content } }),
    [200],
  );
  return response.body;
}

describe("Personal Instructions", () => {
  it("instructions-001 notifies the owner after publishing new personal Instructions", async () => {
    const alice = member();
    await join(alice);

    await save(alice, "Reply in short bullet points.");
    await flushWaitUntilForTest();

    expect(
      countPublishedTo(context.mocks, {
        channel: `user:${alice.userId}`,
        topic: "personalInstructionsChanged",
      }),
    ).toBe(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "personalInstructionsChanged",
      null,
    );
    await expect(read(alice)).resolves.toMatchObject({
      userId: alice.userId,
      orgId: alice.orgId,
      content: "Reply in short bullet points.",
    });
  });

  it("instructions-002 reads the default until each member and workspace saves its own value", async () => {
    const alice = member();
    const bob = member(alice.orgId);
    const aliceElsewhere = member(undefined, "member", alice.userId);
    await join(alice, bob, aliceElsewhere);
    const pairs = [alice, bob, aliceElsewhere];

    for (const pair of pairs) {
      await expect(read(pair)).resolves.toMatchObject({
        userId: pair.userId,
        orgId: pair.orgId,
        content: SINGLE_AGENT_SEED_INSTRUCTIONS,
      });
    }

    const raw = "\uFEFF  第一行\r\n  second line  \r\n";
    await save(alice, raw);
    await expect(read(bob)).resolves.toMatchObject({
      userId: bob.userId,
      content: SINGLE_AGENT_SEED_INSTRUCTIONS,
    });
    await expect(read(aliceElsewhere)).resolves.toMatchObject({
      orgId: aliceElsewhere.orgId,
      content: SINGLE_AGENT_SEED_INSTRUCTIONS,
    });
    await save(bob, "Bob");
    await save(aliceElsewhere, "Alice elsewhere");

    await expect(read(alice)).resolves.toMatchObject({
      userId: alice.userId,
      orgId: alice.orgId,
      content: raw,
    });
    await save(alice, "");
    await expect(read(alice)).resolves.toMatchObject({ content: "" });
  });

  it("instructions-004 does not let a peer or admin choose another personal owner", async () => {
    const alice = member();
    const admin = member(alice.orgId, "admin");
    await join(alice, admin);
    const saved = await save(alice, "Alice private");

    signIn(admin);
    await accept(
      client().update({
        headers,
        body: { content: "Admin override", ifVersion: saved.version },
      }),
      [409],
    );
    const named = await setupRawAppRequest({
      context,
      routes: instructionsRoutes,
    })("/api/instructions", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ content: "Admin override", userId: alice.userId }),
    });
    expect(named.status).toBe(400);

    await expect(read(admin)).resolves.toMatchObject({
      userId: admin.userId,
      orgId: admin.orgId,
      content: SINGLE_AGENT_SEED_INSTRUCTIONS,
    });
    await expect(read(alice)).resolves.toMatchObject({
      userId: alice.userId,
      content: "Alice private",
    });
  });

  it("instructions-007 retains personal content across departure and rejoin", async () => {
    const alice = member();
    await join(alice);
    await save(alice, "Keep my style");
    const before = await read(alice);

    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "organizationMembership.deleted",
      data: {
        organization: { id: alice.orgId },
        public_user_data: { user_id: alice.userId },
      },
    });
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify({ type: "organizationMembership.deleted" }),
        extraHeaders: {
          "svix-id": `msg_${randomUUID()}`,
          "svix-timestamp": String(Math.floor(now() / 1000)),
          "svix-signature": "v1,signed-by-clerk",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    await join(alice);

    await expect(read(alice)).resolves.toStrictEqual(before);
  });
});
