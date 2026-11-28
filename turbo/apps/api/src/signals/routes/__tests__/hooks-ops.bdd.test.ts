import { randomUUID } from "node:crypto";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { healthContract } from "@okouai/api-contracts/contracts/health";
import { createStore } from "ccstate";
import { expect, test } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { authMeRoutes } from "../auth-me";
import { featureSwitchesRoutes } from "../feature-switches";
import { healthRoutes } from "../health";
import { mockClerkUsers } from "./helpers/clerk-users";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const switchesApi = () => {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
};

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

async function workspaceMember(orgId = `org_${randomUUID()}`) {
  const member: Member = { userId: `user_${randomUUID()}`, orgId };
  await createStore().set(
    seedOrgMembership$,
    { ...member, role: "member" },
    context.signal,
  );
  return member;
}

function signIn(member: Member) {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    "org:member",
  );
}

async function readSwitches(member: Member) {
  signIn(member);
  return (await accept(switchesApi().get({ headers }), [200])).body.switches;
}

async function updateSwitches(
  member: Member,
  switches: Record<string, boolean>,
) {
  signIn(member);
  return (
    await accept(switchesApi().update({ headers, body: { switches } }), [200])
  ).body.switches;
}

async function deleteSwitches(member: Member) {
  signIn(member);
  return (await accept(switchesApi().delete({ headers }), [200])).body;
}

test("hooks-ops.bdd-003 reports health and guards the identity read", async () => {
  const member = await workspaceMember();

  const health = await accept(
    setupApp({ context, routes: healthRoutes })(healthContract).check(),
    [200],
  );
  const auth = setupApp({ context, routes: authMeRoutes })(authContract);
  const anonymous = await accept(auth.me({ headers: {} }), [401]);

  signIn(member);
  mockClerkUsers(context, [
    {
      id: member.userId,
      emailAddresses: [
        { id: "email_primary", emailAddress: "member@example.com" },
      ],
      primaryEmailAddressId: "email_primary",
      firstName: "Ops",
      lastName: "Member",
      imageUrl: null,
    },
  ]);
  const me = await accept(auth.me({ headers }), [200]);

  expect(health.body).toStrictEqual({ status: "ok" });
  expect(anonymous.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  expect(me.body).toMatchObject({
    userId: member.userId,
    orgId: member.orgId,
    email: "member@example.com",
  });
});

test("hooks-ops.bdd-004 updates, reads, merges and deletes personal overrides", async () => {
  const member = await workspaceMember();

  const initial = await readSwitches(member);
  const first = await updateSwitches(member, { _dummy: false });
  const second = await updateSwitches(member, { _dummy: true });
  const reread = await readSwitches(member);
  const deleted = await deleteSwitches(member);
  const afterDelete = await readSwitches(member);

  expect(initial).not.toHaveProperty("_dummy");
  expect(first).toMatchObject({ _dummy: false });
  expect(second).toMatchObject({ _dummy: true });
  expect(reread).toStrictEqual(second);
  expect(deleted).toStrictEqual({ deleted: true });
  expect(afterDelete).not.toHaveProperty("_dummy");
});

test("hooks-ops.bdd-005 keeps workspace overrides apart from personal ones", async () => {
  const owner = await workspaceMember();
  const peer = await workspaceMember(owner.orgId);
  const outsider = await workspaceMember();

  const ownerUpdate = await updateSwitches(owner, {
    larkIntegration: true,
    _dummy: false,
  });
  const peerRead = await readSwitches(peer);
  const outsiderRead = await readSwitches(outsider);
  const peerUpdate = await updateSwitches(peer, { larkIntegration: false });
  const ownerRead = await readSwitches(owner);
  const deleted = await deleteSwitches(owner);
  const peerAfterDelete = await readSwitches(peer);

  expect(ownerUpdate).toMatchObject({ larkIntegration: true, _dummy: false });
  expect(peerRead).toMatchObject({ larkIntegration: true });
  expect(peerRead).not.toHaveProperty("_dummy");
  expect(outsiderRead).not.toHaveProperty("larkIntegration");
  expect(peerUpdate).toMatchObject({ larkIntegration: false });
  expect(peerUpdate).not.toHaveProperty("_dummy");
  expect(ownerRead).toMatchObject({ larkIntegration: false, _dummy: false });
  expect(deleted).toStrictEqual({ deleted: true });
  expect(peerAfterDelete).not.toHaveProperty("larkIntegration");
  expect(peerAfterDelete).not.toHaveProperty("_dummy");
});
