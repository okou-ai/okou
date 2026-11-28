import { randomUUID } from "node:crypto";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  CLIENT_TYPE_APP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { featureSwitchesRoutes } from "../feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signIn(
  userId: string,
  orgId: string,
  role: "org:admin" | "org:member" = "org:member",
) {
  createRouteMocks(context).clerk.session(userId, orgId, role);
}

const api = () => {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
};

async function read(extraHeaders?: Record<string, string>) {
  return (await accept(api().get({ headers, extraHeaders }), [200])).body;
}

async function update(
  switches: Record<string, boolean>,
  extraHeaders?: Record<string, string>,
) {
  return (
    await accept(
      api().update({ headers, body: { switches }, extraHeaders }),
      [200],
    )
  ).body;
}

async function reset() {
  return (await accept(api().delete({ headers }), [200])).body;
}

async function effective(key: string) {
  return (await read()).effectiveSwitches[key];
}

function newUser() {
  return `user_${randomUUID()}`;
}

function newOrg() {
  return `org_${randomUUID()}`;
}

const antigravity = FeatureSwitchKey.GeminiAntigravity;
const presentation = FeatureSwitchKey.PresentationOutputFormat;
const lark = FeatureSwitchKey.LarkIntegration;
const realAgent = FeatureSwitchKey.RealAgentInPreview;
const dummy = FeatureSwitchKey.Dummy;
const threePointTiming = FeatureSwitchKey.ArtifactThreePointTiming;

describe("/api/feature-switches", () => {
  it("feature-switches-001 stores the Antigravity opt-in only for the individual staff member", async () => {
    const orgId = createUniqueStaffOrgIdFixture();
    const memberId = newUser();
    signIn(memberId, orgId);

    await expect(effective(antigravity)).resolves.toBeFalsy();
    expect(
      (await update({ [antigravity]: true })).effectiveSwitches[antigravity],
    ).toBeTruthy();
    signIn(newUser(), orgId);
    await expect(effective(antigravity)).resolves.toBeFalsy();
    signIn(memberId, orgId);
    await expect(effective(antigravity)).resolves.toBeTruthy();
    expect(
      (await update({ [antigravity]: false })).effectiveSwitches[antigravity],
    ).toBeFalsy();
  });

  it("feature-switches-002 rejects a direct external Antigravity opt-in before writing any overrides", async () => {
    signIn(newUser(), newOrg(), "org:admin");

    await accept(
      api().update({
        headers,
        body: { switches: { [antigravity]: true, [dummy]: true } },
      }),
      [403],
    );
    const body = await read();

    expect(body.switches).not.toHaveProperty(antigravity);
    expect(body.switches).not.toHaveProperty(dummy);
    expect(body.effectiveSwitches[antigravity]).toBeFalsy();
  });

  it("feature-switches-003 enables presentation format for staff with personal opt-out overrides", async () => {
    const orgId = createUniqueStaffOrgIdFixture();
    const memberId = newUser();
    signIn(memberId, orgId);

    await expect(effective(presentation)).resolves.toBeTruthy();
    expect(
      (await update({ [presentation]: false })).effectiveSwitches[presentation],
    ).toBeFalsy();
    await expect(effective(presentation)).resolves.toBeFalsy();
    signIn(newUser(), orgId);
    await expect(effective(presentation)).resolves.toBeTruthy();
    signIn(memberId, orgId);
    await reset();
    await expect(effective(presentation)).resolves.toBeTruthy();
  });

  it("feature-switches-004 lets an ordinary member opt into presentation format without enabling it for peers", async () => {
    const orgId = newOrg();
    const memberId = newUser();
    signIn(memberId, orgId);

    await expect(effective(presentation)).resolves.toBeFalsy();
    const optedIn = await update({ [presentation]: true });
    expect(optedIn.switches[presentation]).toBeTruthy();
    expect(optedIn.effectiveSwitches[presentation]).toBeTruthy();
    await expect(effective(presentation)).resolves.toBeTruthy();
    signIn(newUser(), orgId);
    await expect(effective(presentation)).resolves.toBeFalsy();
    signIn(memberId, orgId);
    await update({ [presentation]: false });
    await expect(effective(presentation)).resolves.toBeFalsy();
    await update({ [presentation]: true });
    await reset();
    const afterReset = await read();

    expect(afterReset.switches).not.toHaveProperty(presentation);
    expect(afterReset.effectiveSwitches[presentation]).toBeFalsy();
  });

  it("feature-switches-010 shares larkIntegration overrides only within the same organization", async () => {
    const orgId = newOrg();
    const memberId = newUser();
    signIn(memberId, orgId);

    await expect(effective(lark)).resolves.toBeFalsy();
    await update({ [lark]: true });
    signIn(newUser(), orgId);
    await expect(effective(lark)).resolves.toBeTruthy();
    signIn(memberId, newOrg());
    await expect(effective(lark)).resolves.toBeFalsy();
  });

  it("feature-switches-013 returns registered switches while merging known overrides for App 0.1180.0", async () => {
    const app = {
      [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
      [CLIENT_VERSION_HEADER]: "0.1180.0",
    };
    signIn(newUser(), newOrg());
    await update({ [realAgent]: true, [dummy]: false }, app);

    const updated = await update(
      {
        [realAgent]: false,
        unregisteredSwitch: true,
        batchConnectorPermissions: false,
        agentSuggestion: false,
      },
      app,
    );

    expect(updated.switches).toStrictEqual({
      [realAgent]: false,
      [dummy]: false,
    });
    expect(updated.effectiveSwitches).toMatchObject({
      [realAgent]: false,
      [dummy]: false,
      batchConnectorPermissions: true,
    });
    expect(Object.keys(updated.effectiveSwitches).sort()).toStrictEqual(
      [...Object.values(FeatureSwitchKey), "batchConnectorPermissions"].sort(),
    );
    await expect(read(app)).resolves.toStrictEqual(updated);
  });

  it("feature-switches-015 deletes the caller's overrides and organization keys without deleting a peer's personal override", async () => {
    const orgId = newOrg();
    const callerId = newUser();
    const peerId = newUser();
    signIn(callerId, orgId);
    await update({ [lark]: true, [realAgent]: true });
    signIn(peerId, orgId);
    await update({ [dummy]: true });

    signIn(callerId, orgId);
    await expect(reset()).resolves.toStrictEqual({ deleted: true });
    expect((await read()).switches).toStrictEqual({});
    signIn(peerId, orgId);
    const peer = await read();

    expect(peer.switches).toStrictEqual({ [dummy]: true });
    expect(peer.effectiveSwitches[lark]).toBeFalsy();
  });

  it("feature-switches-016 merges a mixed-scope update without exposing the caller's personal override to a peer", async () => {
    const orgId = newOrg();
    const peerId = newUser();
    signIn(peerId, orgId);
    await update({ [dummy]: true });

    signIn(newUser(), orgId);
    const updated = await update({ [lark]: true, [realAgent]: false });
    signIn(peerId, orgId);
    const peer = await read();

    expect(updated.switches).toStrictEqual({
      [lark]: true,
      [realAgent]: false,
    });
    expect(peer.switches).toStrictEqual({ [dummy]: true, [lark]: true });
  });

  it("pf-081 enables three-point timing for external org:member with personal opt-out and reset", async () => {
    const orgId = newOrg();
    const memberId = newUser();
    signIn(memberId, orgId, "org:member");

    await expect(effective(threePointTiming)).resolves.toBeTruthy();
    const optedOut = await update({ [threePointTiming]: false });
    expect(optedOut.switches[threePointTiming]).toBeFalsy();
    expect(optedOut.effectiveSwitches[threePointTiming]).toBeFalsy();

    signIn(newUser(), orgId, "org:member");
    await expect(effective(threePointTiming)).resolves.toBeTruthy();

    signIn(memberId, orgId, "org:member");
    await reset();
    const afterReset = await read();
    expect(afterReset.switches).not.toHaveProperty(threePointTiming);
    expect(afterReset.effectiveSwitches[threePointTiming]).toBeTruthy();
  });
});
