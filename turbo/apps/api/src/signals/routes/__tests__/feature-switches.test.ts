import { randomUUID } from "node:crypto";
import {
  CLIENT_TYPE_APP,
  CLIENT_TYPE_HEADER,
  CLIENT_TYPE_IOS,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import iosClientCompatibility from "../../../lib/ios-client-compatibility.json";
import webClientCompatibility from "../../../lib/web-client-compatibility.json";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { createRouteMocks } from "./helpers/route-test";
import { featureSwitchesRoutes } from "../feature-switches";

const context = testContext();

function client() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}

describe("/api/feature-switches", () => {
  it("stores the Antigravity opt-in only for the individual staff member", async () => {
    const api = client();
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const orgId = createUniqueStaffOrgIdFixture();
    const userId = `user_${randomUUID()}`;
    const key = FeatureSwitchKey.GeminiAntigravity;
    clerk.session(userId, orgId, "org:member");
    const initial = await accept(api.get({ headers }), [200]);
    expect(initial.body.effectiveSwitches[key]).toBe(false);
    const enabled = await accept(
      api.update({ headers, body: { switches: { [key]: true } } }),
      [200],
    );
    expect(enabled.body.effectiveSwitches[key]).toBe(true);

    clerk.session(`user_${randomUUID()}`, orgId, "org:member");
    const peer = await accept(api.get({ headers }), [200]);
    expect(peer.body.effectiveSwitches[key]).toBe(false);
    clerk.session(userId, orgId, "org:member");
    const persisted = await accept(api.get({ headers }), [200]);
    expect(persisted.body.effectiveSwitches[key]).toBe(true);
    const disabled = await accept(
      api.update({ headers, body: { switches: { [key]: false } } }),
      [200],
    );
    expect(disabled.body.effectiveSwitches[key]).toBe(false);
  });

  it("rejects a direct external Antigravity opt-in before writing any overrides", async () => {
    const api = client();
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`, "org:admin");
    const key = FeatureSwitchKey.GeminiAntigravity;
    await accept(
      api.update({
        headers,
        body: { switches: { [key]: true, [FeatureSwitchKey.Dummy]: true } },
      }),
      [403],
    );
    const current = await accept(api.get({ headers }), [200]);
    expect(current.body.switches).not.toHaveProperty(key);
    expect(current.body.switches).not.toHaveProperty(FeatureSwitchKey.Dummy);
    expect(current.body.effectiveSwitches).not.toHaveProperty(key);
  });

  it("enables presentation format for staff with personal opt-out overrides", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const orgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    const userId = `user_${randomUUID()}`;
    const key = FeatureSwitchKey.PresentationOutputFormat;

    clerk.session(userId, orgId, "org:member");
    const initial = await accept(client().get({ headers }), [200]);
    expect(initial.body.effectiveSwitches).toMatchObject({ [key]: true });

    const optedOut = await accept(
      client().update({ headers, body: { switches: { [key]: false } } }),
      [200],
    );
    expect(optedOut.body.effectiveSwitches).toMatchObject({ [key]: false });
    const retained = await accept(client().get({ headers }), [200]);
    expect(retained.body.effectiveSwitches).toMatchObject({ [key]: false });

    clerk.session(`user_${randomUUID()}`, orgId, "org:member");
    const peer = await accept(client().get({ headers }), [200]);
    expect(peer.body.effectiveSwitches).toMatchObject({ [key]: true });

    clerk.session(userId, orgId, "org:member");
    await accept(client().delete({ headers }), [200]);
    const reset = await accept(client().get({ headers }), [200]);
    expect(reset.body.effectiveSwitches).toMatchObject({ [key]: true });
  });

  it("keeps presentation format unavailable to external peers despite a stored opt-in", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const orgId = `org_${randomUUID()}`;
    const ownerId = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV";
    const key = FeatureSwitchKey.PresentationOutputFormat;

    clerk.session(ownerId, orgId, "org:member");
    const owner = await accept(client().get({ headers }), [200]);
    expect(owner.body.effectiveSwitches).toMatchObject({ [key]: true });

    clerk.session(`user_${randomUUID()}`, orgId, "org:admin");
    const peerOptIn = await accept(
      client().update({ headers, body: { switches: { [key]: true } } }),
      [200],
    );
    expect(peerOptIn.body.effectiveSwitches).toMatchObject({ [key]: false });
    const peer = await accept(client().get({ headers }), [200]);
    expect(peer.body.switches).toMatchObject({ [key]: true });
    expect(peer.body.effectiveSwitches).toMatchObject({ [key]: false });

    clerk.session(ownerId, orgId, "org:member");
    const unchangedOwner = await accept(client().get({ headers }), [200]);
    expect(unchangedOwner.body.effectiveSwitches).toMatchObject({
      [key]: true,
    });
    const optedOut = await accept(
      client().update({ headers, body: { switches: { [key]: false } } }),
      [200],
    );
    expect(optedOut.body.effectiveSwitches).toMatchObject({ [key]: false });
    const optedIn = await accept(
      client().update({ headers, body: { switches: { [key]: true } } }),
      [200],
    );
    expect(optedIn.body.effectiveSwitches).toMatchObject({ [key]: true });
  });

  it("keeps three-point timing available to its owner across workspaces with personal opt-out and opt-in", async () => {
    const api = client();
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const ownerId = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV";
    const orgId = `org_${randomUUID()}`;
    const key = FeatureSwitchKey.ArtifactThreePointTiming;

    clerk.session(ownerId, orgId, "org:member");
    const initial = await accept(api.get({ headers }), [200]);
    expect(initial.body.effectiveSwitches).toMatchObject({ [key]: true });
    const optedOut = await accept(
      api.update({ headers, body: { switches: { [key]: false } } }),
      [200],
    );
    expect(optedOut.body.switches).toMatchObject({ [key]: false });
    expect(optedOut.body.effectiveSwitches).toMatchObject({ [key]: false });
    const retained = await accept(api.get({ headers }), [200]);
    expect(retained.body.effectiveSwitches).toMatchObject({ [key]: false });

    clerk.session(`user_${randomUUID()}`, orgId, "org:admin");
    const peer = await accept(api.get({ headers }), [200]);
    expect(peer.body.effectiveSwitches).toMatchObject({ [key]: false });

    clerk.session(ownerId, `org_${randomUUID()}`, "org:member");
    const anotherWorkspace = await accept(api.get({ headers }), [200]);
    expect(anotherWorkspace.body.effectiveSwitches).toMatchObject({
      [key]: true,
    });

    clerk.session(ownerId, orgId, "org:member");
    const stillOptedOut = await accept(api.get({ headers }), [200]);
    expect(stillOptedOut.body.effectiveSwitches).toMatchObject({
      [key]: false,
    });
    const optedIn = await accept(
      api.update({ headers, body: { switches: { [key]: true } } }),
      [200],
    );
    expect(optedIn.body.switches).toMatchObject({ [key]: true });
    expect(optedIn.body.effectiveSwitches).toMatchObject({ [key]: true });
    const enabled = await accept(api.get({ headers }), [200]);
    expect(enabled.body.effectiveSwitches).toMatchObject({ [key]: true });
  });

  it("enables three-point timing for staff members with personal opt-out overrides", async () => {
    const api = client();
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const orgId = createUniqueStaffOrgIdFixture();
    const userId = `user_${randomUUID()}`;
    const key = FeatureSwitchKey.ArtifactThreePointTiming;

    clerk.session(userId, orgId, "org:member");
    const initial = await accept(api.get({ headers }), [200]);
    expect(initial.body.effectiveSwitches).toMatchObject({ [key]: true });

    const optedOut = await accept(
      api.update({ headers, body: { switches: { [key]: false } } }),
      [200],
    );
    expect(optedOut.body.effectiveSwitches).toMatchObject({ [key]: false });
    const retained = await accept(api.get({ headers }), [200]);
    expect(retained.body.effectiveSwitches).toMatchObject({ [key]: false });

    clerk.session(`user_${randomUUID()}`, orgId, "org:member");
    const peer = await accept(api.get({ headers }), [200]);
    expect(peer.body.effectiveSwitches).toMatchObject({ [key]: true });

    clerk.session(userId, orgId, "org:member");
    await accept(api.delete({ headers }), [200]);
    const reset = await accept(api.get({ headers }), [200]);
    expect(reset.body.effectiveSwitches).toMatchObject({ [key]: true });
  });

  it("cannot grant three-point timing to an external admin through a stored opt-in", async () => {
    const api = client();
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const ownerId = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV";
    const orgId = `org_${randomUUID()}`;
    const key = FeatureSwitchKey.ArtifactThreePointTiming;

    clerk.session(ownerId, orgId, "org:member");
    const owner = await accept(api.get({ headers }), [200]);
    expect(owner.body.effectiveSwitches).toMatchObject({ [key]: true });

    clerk.session(`user_${randomUUID()}`, orgId, "org:admin");
    const peerDefault = await accept(api.get({ headers }), [200]);
    expect(peerDefault.body.effectiveSwitches).toMatchObject({ [key]: false });
    const peerOptIn = await accept(
      api.update({ headers, body: { switches: { [key]: true } } }),
      [200],
    );
    expect(peerOptIn.body.switches).toMatchObject({ [key]: true });
    expect(peerOptIn.body.effectiveSwitches).toMatchObject({ [key]: false });
    const peer = await accept(api.get({ headers }), [200]);
    expect(peer.body.switches).toMatchObject({ [key]: true });
    expect(peer.body.effectiveSwitches).toMatchObject({ [key]: false });

    clerk.session(ownerId, orgId, "org:member");
    const unchangedOwner = await accept(api.get({ headers }), [200]);
    expect(unchangedOwner.body.effectiveSwitches).toMatchObject({
      [key]: true,
    });
  });

  it("keeps a personal switch personal within one organization", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const orgId = `org_${randomUUID()}`;
    const optedOutUserId = `user_${randomUUID()}`;
    clerk.session(optedOutUserId, orgId, "org:member");

    const optedOut = await accept(
      client().update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.Dummy]: false },
        },
      }),
      [200],
    );
    expect(optedOut.body.effectiveSwitches[FeatureSwitchKey.Dummy]).toBeFalsy();

    clerk.session(`user_${randomUUID()}`, orgId, "org:member");
    const peer = await accept(client().get({ headers }), [200]);
    expect(peer.body.effectiveSwitches[FeatureSwitchKey.Dummy]).toBeTruthy();

    clerk.session(optedOutUserId, orgId, "org:member");
    const original = await accept(client().get({ headers }), [200]);
    expect(original.body.effectiveSwitches[FeatureSwitchKey.Dummy]).toBeFalsy();
  });

  it.each([
    FeatureSwitchKey.LarkIntegration,
    FeatureSwitchKey.ComposerVoiceMessages,
  ])("shares %s overrides only within the same organization", async (key) => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    clerk.session(userId, orgId, "org:member");
    const initial = await accept(client().get({ headers }), [200]);
    expect(initial.body.effectiveSwitches[key]).toBeFalsy();
    await accept(
      client().update({
        headers,
        body: { switches: { [key]: true } },
      }),
      [200],
    );
    clerk.session(`user_${randomUUID()}`, orgId, "org:member");
    const peer = await accept(client().get({ headers }), [200]);
    expect(peer.body.effectiveSwitches[key]).toBeTruthy();
    clerk.session(userId, `org_${randomUUID()}`, "org:member");
    const elsewhere = await accept(client().get({ headers }), [200]);
    expect(elsewhere.body.effectiveSwitches[key]).toBeFalsy();
  });

  it("merges concurrent unrelated personal keys without losing either override", async () => {
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );
    const headers = { authorization: "Bearer clerk-session" };
    const api = client();
    await Promise.all([
      accept(
        api.update({
          headers,
          body: {
            switches: { [FeatureSwitchKey.RealAgentInPreview]: true },
          },
        }),
        [200],
      ),
      accept(
        api.update({
          headers,
          body: { switches: { [FeatureSwitchKey.Dummy]: false } },
        }),
        [200],
      ),
    ]);
    const current = await accept(api.get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual({
      [FeatureSwitchKey.RealAgentInPreview]: true,
      [FeatureSwitchKey.Dummy]: false,
    });
  });

  it.each([
    {
      type: CLIENT_TYPE_APP,
      version: webClientCompatibility.minimumSupportedVersion,
    },
    {
      type: CLIENT_TYPE_IOS,
      version: iosClientCompatibility.testFlightMinimumSupportedVersion,
    },
  ])(
    "returns registered switches while merging known overrides for $type $version",
    async ({ type, version }) => {
      createRouteMocks(context).clerk.session(
        `user_${randomUUID()}`,
        `org_${randomUUID()}`,
        "org:member",
      );
      const headers = {
        authorization: "Bearer clerk-session",
        [CLIENT_TYPE_HEADER]: type,
        [CLIENT_VERSION_HEADER]: version,
      };
      await accept(
        client().update({
          headers,
          body: {
            switches: {
              [FeatureSwitchKey.RealAgentInPreview]: true,
              [FeatureSwitchKey.Dummy]: false,
            },
          },
        }),
        [200],
      );
      const updated = await accept(
        client().update({
          headers,
          body: {
            switches: {
              [FeatureSwitchKey.RealAgentInPreview]: false,
              unregisteredFeature: true,
              batchConnectorPermissions: false,
            },
          },
        }),
        [200],
      );
      const expected = {
        [FeatureSwitchKey.RealAgentInPreview]: false,
        [FeatureSwitchKey.Dummy]: false,
      };
      expect(updated.body.switches).toStrictEqual(expected);
      expect(updated.body.effectiveSwitches).toMatchObject({
        ...expected,
        batchConnectorPermissions: true,
      });
      expect(Object.keys(updated.body.effectiveSwitches).sort()).toStrictEqual(
        [
          ...Object.values(FeatureSwitchKey),
          "batchConnectorPermissions",
        ].sort(),
      );
      const current = await accept(client().get({ headers }), [200]);
      expect(current.body.switches).toStrictEqual(expected);
      expect(current.body.effectiveSwitches).toStrictEqual(
        updated.body.effectiveSwitches,
      );
    },
  );

  it("deletes the caller's overrides and organization keys without deleting a peer's personal override", async () => {
    const clerk = createRouteMocks(context).clerk;
    const orgId = `org_${randomUUID()}`;
    const caller = `user_${randomUUID()}`;
    const peer = `user_${randomUUID()}`;
    const headers = { authorization: "Bearer clerk-session" };
    clerk.session(caller, orgId, "org:member");
    await accept(
      client().update({
        headers,
        body: {
          switches: {
            [FeatureSwitchKey.LarkIntegration]: true,
            [FeatureSwitchKey.RealAgentInPreview]: true,
          },
        },
      }),
      [200],
    );
    clerk.session(peer, orgId, "org:member");
    await accept(
      client().update({
        headers,
        body: {
          switches: {
            [FeatureSwitchKey.Dummy]: true,
          },
        },
      }),
      [200],
    );
    clerk.session(caller, orgId, "org:member");
    const deleted = await accept(client().delete({ headers }), [200]);
    expect(deleted.body.deleted).toBeTruthy();
    const callerState = await accept(client().get({ headers }), [200]);
    expect(callerState.body.switches).toStrictEqual({});
    clerk.session(peer, orgId, "org:member");
    const peerState = await accept(client().get({ headers }), [200]);
    expect(peerState.body.switches).toStrictEqual({
      [FeatureSwitchKey.Dummy]: true,
    });
    expect(
      peerState.body.effectiveSwitches[FeatureSwitchKey.LarkIntegration],
    ).toBeFalsy();
  });

  it("merges a mixed-scope update without exposing the caller's personal override to a peer", async () => {
    const clerk = createRouteMocks(context).clerk;
    const orgId = `org_${randomUUID()}`;
    const peerId = `user_${randomUUID()}`;
    const headers = { authorization: "Bearer clerk-session" };
    clerk.session(peerId, orgId, "org:member");
    await accept(
      client().update({
        headers,
        body: {
          switches: {
            [FeatureSwitchKey.Dummy]: true,
          },
        },
      }),
      [200],
    );
    clerk.session(`user_${randomUUID()}`, orgId, "org:member");
    const updated = await accept(
      client().update({
        headers,
        body: {
          switches: {
            [FeatureSwitchKey.LarkIntegration]: true,
            [FeatureSwitchKey.RealAgentInPreview]: false,
          },
        },
      }),
      [200],
    );
    expect(updated.body.switches).toStrictEqual({
      [FeatureSwitchKey.LarkIntegration]: true,
      [FeatureSwitchKey.RealAgentInPreview]: false,
    });
    clerk.session(peerId, orgId, "org:member");
    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual({
      [FeatureSwitchKey.Dummy]: true,
      [FeatureSwitchKey.LarkIntegration]: true,
    });
  });

  it.each([true, false])(
    "echoes and persists a stored org-scoped override as %s",
    async (enabled) => {
      createRouteMocks(context).clerk.session(
        `user_${randomUUID()}`,
        `org_${randomUUID()}`,
        "org:member",
      );
      const headers = { authorization: "Bearer clerk-session" };

      const updated = await accept(
        client().update({
          headers,
          body: {
            switches: {
              [FeatureSwitchKey.LarkIntegration]: enabled,
            },
          },
        }),
        [200],
      );

      expect(updated.body.switches).toStrictEqual({
        [FeatureSwitchKey.LarkIntegration]: enabled,
      });
      expect(
        updated.body.effectiveSwitches[FeatureSwitchKey.LarkIntegration],
      ).toBe(enabled);

      const current = await accept(client().get({ headers }), [200]);
      expect(current.body.switches).toStrictEqual({
        [FeatureSwitchKey.LarkIntegration]: enabled,
      });
      expect(
        current.body.effectiveSwitches[FeatureSwitchKey.LarkIntegration],
      ).toBe(enabled);
    },
  );
});
