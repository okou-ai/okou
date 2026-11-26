import { randomUUID } from "node:crypto";

import { antigravityPersonalSubscriptionContract } from "@okouai/api-contracts/contracts/antigravity-personal-subscription";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { antigravityPersonalSubscriptionRoutes } from "../antigravity-personal-subscription";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();

const memberHeaders = Object.freeze({ authorization: "Bearer clerk-session" });
// Members are unique per case; the staff organization identity only selects
// the production staff gate, so one hash-colliding org serves the file.
const staffOrgId = createUniqueStaffOrgIdFixture();

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

type Worker = Member & { readonly machineId: string } & (
    { readonly loginHost: string } | { readonly loginOrigin: string }
  );

function newMember(orgId: string = staffOrgId): Member {
  return { userId: `user_${randomUUID()}`, orgId };
}

function machineHeaders(machineId: string) {
  return { authorization: `Bearer m2m:${machineId}` };
}

function isMachineRequest(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    "acceptsToken" in options &&
    options.acceptsToken === "m2m_token"
  );
}

/**
 * Clerk answers member sessions for `member` and machine tokens for the
 * machine named in the bearer token; Clerk lists each worker's member as an
 * organization member.
 */
function clerkAs(member: Member): void {
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request: unknown, options: unknown) => {
      if (!isMachineRequest(options)) {
        return Promise.resolve({
          isAuthenticated: true,
          toAuth: () => {
            return {
              userId: member.userId,
              orgId: member.orgId,
              orgRole: "org:admin",
            };
          },
        });
      }
      const header =
        request instanceof Request
          ? (request.headers.get("authorization") ?? "")
          : "";
      const machineId = header.startsWith("Bearer m2m:")
        ? header.slice("Bearer m2m:".length)
        : null;
      return Promise.resolve(
        machineId
          ? {
              isAuthenticated: true,
              toAuth: () => {
                return {
                  tokenType: "m2m_token",
                  machineId,
                  id: `mt_${machineId}`,
                };
              },
            }
          : {
              isAuthenticated: false,
              toAuth: () => {
                return null;
              },
            },
      );
    },
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (params: unknown) => {
      const query = params as { organizationId: string; userId: string[] };
      return Promise.resolve({
        data: query.userId.map((userId) => {
          return {
            organization: { id: query.organizationId },
            publicUserData: { userId },
          };
        }),
      });
    },
  );
}

async function optIn(member: Member): Promise<void> {
  await updateFeatureSwitchesForUser(context, member, {
    [FeatureSwitchKey.GeminiAntigravity]: true,
  });
}

function assignWorkers(workers: readonly Worker[]): void {
  mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", "ak_machine_secret");
  mockOptionalEnv("ANTIGRAVITY_SUBSCRIPTION_WORKERS", JSON.stringify(workers));
}

function workerFor(
  member: Member,
  name: string,
): Worker & { readonly loginHost: string } {
  return {
    ...member,
    machineId: `mch_${randomUUID()}`,
    loginHost: `${name}@agy-${randomUUID().slice(0, 8)}.internal`,
  };
}

function subscriptionClient() {
  return setupApp({ context, routes: antigravityPersonalSubscriptionRoutes })(
    antigravityPersonalSubscriptionContract,
  );
}

describe("member-owned Antigravity login", () => {
  it("antigravity-personal-subscription-001 requires staff opt-in and a dedicated worker", async () => {
    const api = subscriptionClient();
    const member = newMember();
    assignWorkers([]);

    clerkAs(member);
    await accept(api.get({ headers: memberHeaders }), [404]);
    await accept(api.start({ headers: memberHeaders, body: {} }), [404]);

    await optIn(member);
    clerkAs(member);
    const unassigned = await accept(api.get({ headers: memberHeaders }), [200]);
    expect(unassigned.body).toStrictEqual({ status: "unassigned" });
    await accept(api.start({ headers: memberHeaders, body: {} }), [503]);

    const shared = workerFor(member, "alice");
    assignWorkers([
      shared,
      { ...workerFor(newMember(), "peer"), machineId: shared.machineId },
    ]);
    await accept(api.start({ headers: memberHeaders, body: {} }), [503]);

    clerkAs(newMember(`org_${randomUUID()}`));
    await accept(api.get({ headers: memberHeaders }), [404]);
  });

  it("antigravity-personal-subscription-002 binds the exact member and keeps the binding when another member disconnects it", async () => {
    const api = subscriptionClient();
    const alice = newMember();
    const bob = newMember();
    await optIn(alice);
    await optIn(bob);
    const aliceWorker = workerFor(alice, "alice");
    const bobWorker = workerFor(bob, "bob");
    assignWorkers([aliceWorker, bobWorker]);

    clerkAs(alice);
    const [first, second] = await Promise.all([
      accept(api.start({ headers: memberHeaders, body: {} }), [200]),
      accept(api.start({ headers: memberHeaders, body: {} }), [200]),
    ]);
    expect(first.body).toMatchObject({
      status: "pending",
      loginHost: aliceWorker.loginHost,
    });
    expect(second.body).toStrictEqual(first.body);
    const bindingId =
      "bindingId" in first.body ? first.body.bindingId : "missing";

    await accept(
      api.confirm({ headers: {}, params: { bindingId }, body: {} }),
      [403],
    );
    await accept(
      api.confirm({
        headers: machineHeaders(bobWorker.machineId),
        params: { bindingId },
        body: {},
      }),
      [404],
    );
    const connected = await accept(
      api.confirm({
        headers: machineHeaders(aliceWorker.machineId),
        params: { bindingId },
        body: {},
      }),
      [200],
    );
    expect(connected.body).toStrictEqual({
      status: "connected",
      bindingId,
      loginHost: aliceWorker.loginHost,
    });
    const repeated = await accept(
      api.confirm({
        headers: machineHeaders(aliceWorker.machineId),
        params: { bindingId },
        body: {},
      }),
      [200],
    );
    expect(repeated.body).toStrictEqual(connected.body);

    clerkAs(bob);
    const bobStatus = await accept(api.get({ headers: memberHeaders }), [200]);
    expect(bobStatus.body).toStrictEqual({ status: "disconnected" });
    await accept(
      api.disconnect({ headers: memberHeaders, params: { bindingId } }),
      [200],
    );

    clerkAs(alice);
    const aliceStatus = await accept(
      api.get({ headers: memberHeaders }),
      [200],
    );
    expect(aliceStatus.body).toStrictEqual(connected.body);
  });

  it("antigravity-personal-subscription-003 returns only the member's HTTPS terminal and refuses to share it", async () => {
    const api = subscriptionClient();
    const alice = newMember();
    const bob = newMember();
    await optIn(alice);
    const loginOrigin = `https://alice-${randomUUID().slice(0, 8)}.agy.example.com`;
    const aliceWorker: Worker = {
      ...alice,
      machineId: `mch_${randomUUID()}`,
      loginOrigin,
    };
    assignWorkers([aliceWorker]);

    clerkAs(alice);
    const pending = await accept(
      api.start({ headers: memberHeaders, body: {} }),
      [200],
    );
    expect(pending.body).toMatchObject({ status: "pending", loginOrigin });
    expect(pending.body).not.toHaveProperty("loginHost");
    const bindingId =
      "bindingId" in pending.body ? pending.body.bindingId : "missing";
    const connected = await accept(
      api.confirm({
        headers: machineHeaders(aliceWorker.machineId),
        params: { bindingId },
        body: {},
      }),
      [200],
    );
    expect(connected.body).toStrictEqual({
      status: "connected",
      bindingId,
      loginOrigin,
    });

    await optIn(bob);
    assignWorkers([
      aliceWorker,
      { ...bob, machineId: `mch_${randomUUID()}`, loginOrigin },
    ]);
    clerkAs(bob);
    await accept(api.start({ headers: memberHeaders, body: {} }), [503]);
  });

  it("antigravity-personal-subscription-006 explains that cloud runs are not enabled after a native sign-in", async () => {
    const api = subscriptionClient();
    const member = newMember();
    await optIn(member);
    const worker = workerFor(member, "member");
    assignWorkers([worker]);

    clerkAs(member);
    const pending = await accept(
      api.start({ headers: memberHeaders, body: {} }),
      [200],
    );
    const bindingId =
      "bindingId" in pending.body ? pending.body.bindingId : "missing";
    await accept(
      api.confirm({
        headers: machineHeaders(worker.machineId),
        params: { bindingId },
        body: {},
      }),
      [200],
    );

    const created = await accept(
      setupApp({ context, routes: chatThreadCreateRoutes })(
        chatThreadsContract,
      ).create({ headers: memberHeaders, body: { model: "gemini-4-neon" } }),
      [400],
    );
    expect(created.body.error.message).toBe(
      "Your Google AI subscription is connected. Cloud runs for this model are not enabled yet.",
    );
  });
});
