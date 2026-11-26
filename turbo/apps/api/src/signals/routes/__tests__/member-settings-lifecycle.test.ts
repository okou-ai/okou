import { randomUUID } from "node:crypto";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { orgLeaveContract } from "@okouai/api-contracts/contracts/org-routes";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { featureSwitchesRoutes } from "../feature-switches";
import { orgMembersRoutes } from "../org-members";
import { orgReadRoutes } from "../org-read";
import { userPreferencesRoutes } from "../user-preferences";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const store = createStore();
const dummy = FeatureSwitchKey.Dummy;
const app = setupApp({
  context,
  routes: [
    ...userPreferencesRoutes,
    ...featureSwitchesRoutes,
    ...orgReadRoutes,
    ...orgMembersRoutes,
  ],
});

interface Identity {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
}

function headersFor(identity: Identity) {
  return { authorization: `Bearer ${identity.userId}:${identity.orgId}` };
}

/** Clerk has issued no bearer sessions when a scenario starts. */
function installSessions() {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
    toAuth: () => {
      return null;
    },
  });
}

/** Clerk resolves the identity's bearer session, in addition to earlier ones. */
function issueSession(identity: Identity) {
  const authorization = headersFor(identity).authorization;
  const issued =
    context.mocks.clerk.authenticateRequest.getMockImplementation();
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request: unknown) => {
      const header =
        request instanceof Request
          ? (request.headers.get("authorization") ?? "")
          : "";
      if (header === authorization) {
        return Promise.resolve({
          isAuthenticated: true,
          toAuth: () => {
            return {
              userId: identity.userId,
              orgId: identity.orgId,
              orgRole: identity.role === "admin" ? "org:admin" : "org:member",
            };
          },
        });
      }
      return issued
        ? issued(request)
        : Promise.resolve({
            isAuthenticated: false,
            toAuth: () => {
              return null;
            },
          });
    },
  );
}

async function join(identity: Identity) {
  issueSession(identity);
  await store.set(
    seedOrgMembership$,
    { orgId: identity.orgId, userId: identity.userId, role: identity.role },
    context.signal,
  );
}

async function initialize(identity: Identity) {
  await accept(
    app(userPreferencesContract).initialize({
      headers: headersFor(identity),
      body: { locale: "en-US", timezone: "UTC" },
    }),
    [200],
  );
}

async function saveDummyOff(identity: Identity) {
  await accept(
    app(featureSwitchesContract).update({
      headers: headersFor(identity),
      body: { switches: { [dummy]: false } },
    }),
    [200],
  );
}

async function readSwitches(identity: Identity) {
  return (
    await accept(
      app(featureSwitchesContract).get({ headers: headersFor(identity) }),
      [200],
    )
  ).body;
}

async function scenario() {
  installSessions();
  const orgId = `org_${randomUUID()}`;
  const memberId = `user_${randomUUID()}`;
  const member: Identity = { userId: memberId, orgId, role: "member" };
  const admin: Identity = {
    userId: `user_${randomUUID()}`,
    orgId,
    role: "admin",
  };
  const elsewhere: Identity = {
    userId: memberId,
    orgId: `org_${randomUUID()}`,
    role: "admin",
  };
  await join(admin);
  await join(elsewhere);
  await join(member);
  await Promise.all([
    saveDummyOff(admin),
    saveDummyOff(elsewhere),
    initialize(member).then(() => {
      return saveDummyOff(member);
    }),
  ]);
  return { member, admin, elsewhere };
}

async function expectSettingsPreserved(
  member: Identity,
  admin: Identity,
  elsewhere: Identity,
) {
  await join(member);
  await initialize(member);
  const [reinitialized, adminSwitches, otherSwitches] = await Promise.all([
    readSwitches(member),
    readSwitches(admin),
    readSwitches(elsewhere),
  ]);
  expect(reinitialized.switches).toStrictEqual({ [dummy]: false });
  expect(reinitialized.effectiveSwitches[dummy]).toBeFalsy();
  expect(adminSwitches.switches).toStrictEqual({ [dummy]: false });
  expect(otherSwitches.switches).toStrictEqual({ [dummy]: false });
}

describe("Member settings across membership changes", () => {
  it("member-settings-lifecycle-001 keeps a member's settings after leaving and initializing again", async () => {
    const { member, admin, elsewhere } = await scenario();

    const left = await accept(
      app(orgLeaveContract).leave({ headers: headersFor(member), body: {} }),
      [200],
    );
    expect(left.body).toStrictEqual({ message: "Left org" });

    await expectSettingsPreserved(member, admin, elsewhere);
  });

  it("member-settings-lifecycle-002 keeps a member's settings after removal and initializing again", async () => {
    const { member, admin, elsewhere } = await scenario();
    const email = `${member.userId}@example.com`;
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: member.userId }],
    });

    const removed = await accept(
      app(orgMembersContract).removeMember({
        headers: headersFor(admin),
        body: { email },
      }),
      [200],
    );
    expect(removed.body).toStrictEqual({
      message: `Removed ${email} from org`,
    });

    await expectSettingsPreserved(member, admin, elsewhere);
  });
});
