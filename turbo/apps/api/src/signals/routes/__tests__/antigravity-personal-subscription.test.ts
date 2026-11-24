import { randomUUID } from "node:crypto";
import { antigravityPersonalSubscriptionContract as contract } from "@okouai/api-contracts/contracts/antigravity-personal-subscription";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { mockOptionalEnv } from "../../../lib/env";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { antigravityPersonalSubscriptionRoutes } from "../antigravity-personal-subscription";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerk = createRouteMocks(context).clerk;
const key = FeatureSwitchKey.GeminiAntigravity;
const client = () => {
  return setupApp({ context, routes: antigravityPersonalSubscriptionRoutes })(
    contract,
  );
};
function makeOwner(orgId = createUniqueStaffOrgIdFixture()) {
  return {
    orgId,
    userId: `user_${randomUUID()}`,
    machineId: `mch_${randomUUID()}`,
    loginHost: "tester@agy.internal.example",
  };
}
function configure(
  ...workers: (Omit<ReturnType<typeof makeOwner>, "loginHost"> &
    ({ loginHost: string } | { loginOrigin: string }))[]
) {
  mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", "msk_test_receiver");
  mockOptionalEnv("ANTIGRAVITY_SUBSCRIPTION_WORKERS", JSON.stringify(workers));
}
function asMachine(owner: ReturnType<typeof makeOwner>) {
  const { machineId } = owner;
  mockClerkMembership(
    context,
    { ...owner, orgRole: "org:member", email: "member@example.test" },
    "org:member",
  );
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return { tokenType: "m2m_token", machineId, id: "m2m_valid" };
    },
  });
}
function confirm(bindingId: string) {
  return client().confirm({
    headers: { authorization: "Bearer mt_worker" },
    params: { bindingId },
    body: {},
  });
}
async function start() {
  const response = await accept(client().start({ headers, body: {} }), [200]);
  if (response.body.status !== "pending") {
    throw new Error("Expected a pending binding");
  }
  return response.body;
}

describe("member-owned Antigravity login", () => {
  it("requires staff opt-in and assignment to an individual worker", async () => {
    const owner = makeOwner();
    clerk.session(owner.userId, owner.orgId);
    await accept(client().get({ headers }), [404]);
    await accept(client().start({ headers, body: {} }), [404]);
    await updateFeatureSwitchesForUser(context, owner, { [key]: true });
    configure();
    expect((await accept(client().get({ headers }), [200])).body.status).toBe(
      "unassigned",
    );
    await accept(client().start({ headers, body: {} }), [503]);
    const peer = makeOwner(owner.orgId);
    configure(owner, { ...peer, machineId: owner.machineId });
    await accept(client().start({ headers, body: {} }), [503]);
    clerk.session(owner.userId, `org_${randomUUID()}`);
    await accept(client().get({ headers }), [404]);
  });

  it("binds the exact member, reuses a pending request, and tolerates a lost confirmation", async () => {
    const a = makeOwner();
    const b = makeOwner(a.orgId);
    configure(a, b);
    await updateFeatureSwitchesForUser(context, b, { [key]: true });
    await updateFeatureSwitchesForUser(context, a, { [key]: true });
    const [first, again] = await Promise.all([start(), start()]);
    expect(again).toStrictEqual(first);
    expect(first).toMatchObject({ loginHost: a.loginHost });
    const bindingId = first.bindingId;
    await accept(confirm(bindingId), [403]);
    asMachine(b);
    await accept(confirm(bindingId), [404]);
    asMachine(a);
    const confirmed = await accept(confirm(bindingId), [200]);
    expect(confirmed.body).toStrictEqual({
      status: "connected",
      bindingId,
      loginHost: a.loginHost,
    });
    expect((await accept(confirm(bindingId), [200])).body).toStrictEqual(
      confirmed.body,
    );
    clerk.session(b.userId, b.orgId);
    expect((await accept(client().get({ headers }), [200])).body).toStrictEqual(
      {
        status: "disconnected",
      },
    );
    await accept(
      client().disconnect({ headers, params: { bindingId } }),
      [200],
    );
    clerk.session(a.userId, a.orgId);
    expect((await accept(client().get({ headers }), [200])).body).toStrictEqual(
      confirmed.body,
    );
  });

  it("returns only the member's HTTPS terminal and refuses to share it between members", async () => {
    const a = makeOwner();
    const b = makeOwner(a.orgId);
    const terminal = {
      orgId: a.orgId,
      userId: a.userId,
      machineId: a.machineId,
      loginOrigin: "https://alice.agy.example.com",
    };
    await updateFeatureSwitchesForUser(context, a, { [key]: true });
    configure(terminal);
    const first = await start();
    expect(first).toHaveProperty("loginOrigin", terminal.loginOrigin);
    expect(first).not.toHaveProperty("loginHost");
    asMachine(a);
    expect((await accept(confirm(first.bindingId), [200])).body).toEqual({
      status: "connected",
      bindingId: first.bindingId,
      loginOrigin: terminal.loginOrigin,
    });
    clerk.session(b.userId, b.orgId);
    await updateFeatureSwitchesForUser(context, b, { [key]: true });
    configure(terminal, {
      ...terminal,
      userId: b.userId,
      machineId: b.machineId,
    });
    await accept(client().start({ headers, body: {} }), [503]);
  });

  it("rejects a worker whose owner left the organization and still allows cleanup", async () => {
    const owner = makeOwner();
    configure(owner);
    await updateFeatureSwitchesForUser(context, owner, { [key]: true });
    const { bindingId } = await start();
    asMachine(owner);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    await accept(confirm(bindingId), [404]);
    await accept(
      client().workerDisconnect({ headers, params: { bindingId } }),
      [200],
    );
    clerk.session(owner.userId, owner.orgId);
    expect((await accept(client().get({ headers }), [200])).body.status).toBe(
      "disconnected",
    );
  });

  it("expires an unconfirmed login, rotates the binding ID, and rejects the old proof", async () => {
    const owner = makeOwner();
    configure(owner);
    await updateFeatureSwitchesForUser(context, owner, { [key]: true });
    const first = await start();
    mockNow(Date.parse(first.expiresAt) + 1);
    expect((await accept(client().get({ headers }), [200])).body.status).toBe(
      "expired",
    );
    asMachine(owner);
    await accept(confirm(first.bindingId), [404]);
    clerk.session(owner.userId, owner.orgId);
    const next = await start();
    expect(next.bindingId).not.toBe(first.bindingId);
    asMachine(owner);
    await accept(confirm(first.bindingId), [404]);
    await accept(confirm(next.bindingId), [200]);
  });

  it("reports the disabled cloud route separately from a successful native Google sign-in", async () => {
    const owner = makeOwner();
    configure(owner);
    await updateFeatureSwitchesForUser(context, owner, { [key]: true });
    const binding = await start();
    asMachine(owner);
    await accept(confirm(binding.bindingId), [200]);
    clerk.session(owner.userId, owner.orgId);
    const threads = setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    );
    const result = await accept(
      threads.create({ headers, body: { model: "gemini-4-neon" } }),
      [400],
    );
    expect(result.body.error.message).toBe(
      "Your Google AI subscription is connected. Cloud runs for this model are not enabled yet.",
    );
  });

  it("revokes with the switch off and fences old confirmations and old disconnects after reconnect", async () => {
    const owner = makeOwner();
    configure(owner);
    await updateFeatureSwitchesForUser(context, owner, { [key]: true });
    const { bindingId } = await start();
    asMachine(owner);
    await accept(confirm(bindingId), [200]);
    await updateFeatureSwitchesForUser(context, owner, { [key]: false });
    asMachine(owner);
    await accept(
      client().workerStatus({ headers, params: { bindingId } }),
      [404],
    );
    clerk.session(owner.userId, owner.orgId);
    expect(
      (
        await accept(
          client().disconnect({ headers, params: { bindingId } }),
          [200],
        )
      ).body.status,
    ).toBe("disconnected");
    await updateFeatureSwitchesForUser(context, owner, { [key]: true });
    const second = await start();
    expect(second.bindingId).not.toBe(bindingId);
    asMachine(owner);
    await accept(confirm(bindingId), [404]);
    clerk.session(owner.userId, owner.orgId);
    await accept(
      client().disconnect({ headers, params: { bindingId } }),
      [404],
    );
    expect((await accept(client().get({ headers }), [200])).body).toStrictEqual(
      second,
    );
  });
});
