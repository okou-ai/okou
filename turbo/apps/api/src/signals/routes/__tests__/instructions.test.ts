import { randomUUID } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { SINGLE_AGENT_SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { instructionsRoutes } from "../instructions";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const client = () => {
  return setupApp({ context, routes: instructionsRoutes })(
    instructionsContract,
  );
};
const actor = (
  orgId = `org_${randomUUID()}`,
  userId = `user_${randomUUID()}`,
) => {
  return { orgId, userId };
};
async function enable(user: ReturnType<typeof actor>) {
  await updateFeatureSwitchesForUser(context, user, { singleAgent: true });
  mocks.clerk.session(user.userId, user.orgId, "org:member");
}
async function read() {
  return (await accept(client().get({ headers }), [200])).body;
}
async function save(content: string, ifVersion?: string) {
  return await accept(
    client().update({ headers, body: { content, ifVersion } }),
    [200],
  );
}

describe("Personal Instructions", () => {
  it("notifies the owner after publishing new personal Instructions", async () => {
    const owner = actor();
    await enable(owner);
    await save("Updated personal instructions");
    await flushWaitUntilForTest();
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `user:${owner.userId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "personalInstructionsChanged",
      null,
    );
    await expect(read()).resolves.toMatchObject({
      ...owner,
      content: "Updated personal instructions",
    });
  });

  it("reads the default until each member/workspace saves its own value", async () => {
    installWorkflowVolumeS3Fixture(context);
    const alice = actor();
    const bob = actor(alice.orgId);
    const elsewhere = actor(undefined, alice.userId);
    await enable(alice);
    await expect(read()).resolves.toMatchObject({
      ...alice,
      content: SINGLE_AGENT_SEED_INSTRUCTIONS,
    });
    const raw = "\uFEFF  Alice\r\n中文\n\n  ";
    await save(raw);
    await enable(bob);
    await expect(read()).resolves.toMatchObject({
      ...bob,
      content: SINGLE_AGENT_SEED_INSTRUCTIONS,
    });
    await save("Bob");
    await enable(elsewhere);
    await expect(read()).resolves.toMatchObject({
      ...elsewhere,
      content: SINGLE_AGENT_SEED_INSTRUCTIONS,
    });
    await save("Alice elsewhere");
    await enable(alice);
    await expect(read()).resolves.toMatchObject({ ...alice, content: raw });
    await save("");
    expect((await read()).content).toBe("");
  });

  it("protects newer saves with a version while allowing an explicit unconditional replace", async () => {
    await enable(actor());
    const original = await read();
    const attempts = await Promise.all(
      ["one", "two"].map((content) => {
        return accept(
          client().update({
            headers,
            body: { content, ifVersion: original.version },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      attempts
        .map((attempt) => {
          return attempt.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const current = await read();
    expect(current.version).not.toBe(original.version);
    expect(["one", "two"]).toContain(current.content);
    await accept(
      client().update({
        headers,
        body: { content: "stale", ifVersion: original.version },
      }),
      [409],
    );
    await expect(read()).resolves.toStrictEqual(current);
    await save("unconditional");
    expect((await read()).content).toBe("unconditional");
  });

  it("does not let a peer or admin choose another personal owner", async () => {
    const alice = actor();
    const admin = actor(alice.orgId);
    await enable(alice);
    const { body: aliceSaved } = await save("Alice private");
    await enable(admin);
    mocks.clerk.session(admin.userId, admin.orgId, "org:admin");
    await accept(
      client().update({
        headers,
        body: { content: "Targeted edit", ifVersion: aliceSaved.version },
      }),
      [409],
    );
    const raw = setupRawAppRequest({ context, routes: instructionsRoutes });
    const rejected = await raw("/api/instructions", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Targeted edit", userId: alice.userId }),
    });
    expect(rejected.status).toBe(400);
    await expect(read()).resolves.toMatchObject({
      ...admin,
      content: SINGLE_AGENT_SEED_INSTRUCTIONS,
    });
    await enable(alice);
    expect((await read()).content).toBe("Alice private");
  });

  it.each([HeadObjectCommand, PutObjectCommand])(
    "keeps the saved value when publication fails at %s and permits a later retry",
    async (command) => {
      installWorkflowVolumeS3Fixture(context);
      await enable(actor());
      await save("published");
      const before = await read();
      const send = context.mocks.s3.send.getMockImplementation()!;
      context.mocks.s3.send.mockImplementation((request: unknown, ...args) => {
        if (request instanceof command) {
          return Promise.reject(new Error("Publication unavailable"));
        }
        return send(request, ...args);
      });
      const failing = setupApp({
        context,
        routes: instructionsRoutes,
        rethrowErrors: false,
      })(instructionsContract);
      await accept(
        failing.update({ headers, body: { content: "not published" } }),
        [500],
      );
      await expect(read()).resolves.toStrictEqual(before);
      context.mocks.s3.send.mockImplementation(send);
      await save("retry");
      expect((await read()).content).toBe("retry");
    },
  );

  it("retains personal content across departure and rejoin", async () => {
    const alice = actor();
    await enable(alice);
    await save("retained across rejoin");
    const before = await read();
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.deleted",
      data: {
        id: "membership",
        organization: { id: alice.orgId },
        public_user_data: { user_id: alice.userId },
      },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    await enable(alice);
    await expect(read()).resolves.toStrictEqual(before);
  });

  it("leaves disabled member access gated", async () => {
    const user = actor();
    await updateFeatureSwitchesForUser(context, user, { singleAgent: false });
    mocks.clerk.session(user.userId, user.orgId);
    const denied = await accept(client().get({ headers }), [403]);
    expect(denied.body.error.code).toBe("FORBIDDEN");
    await accept(
      client().update({ headers, body: { content: "disabled" } }),
      [403],
    );
  });
});
