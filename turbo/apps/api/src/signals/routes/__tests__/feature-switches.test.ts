import { randomUUID } from "node:crypto";
import {
  CLIENT_TYPE_APP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import webClientCompatibility from "../../../lib/web-client-compatibility.json";
import { createRouteMocks } from "./helpers/route-test";
import { featureSwitchesRoutes } from "../feature-switches";

const context = testContext();

function client() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}

describe("/api/feature-switches", () => {
  it("keeps Projects availability with My Okou for each workspace membership", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const userId = `user_${randomUUID()}`;
    const retainedOrg = `org_${randomUUID()}`;
    const newOrg = `org_${randomUUID()}`;
    clerk.session(userId, retainedOrg, "org:member");
    const retained = await accept(
      client().update({
        headers,
        body: { switches: { [FeatureSwitchKey.SingleAgent]: false } },
      }),
      [200],
    );
    expect(retained.body.effectiveSwitches).toMatchObject({
      singleAgent: false,
      projects: false,
    });

    clerk.session(userId, newOrg, "org:member");
    const initialized = await accept(client().get({ headers }), [200]);
    expect(initialized.body.effectiveSwitches).toMatchObject({
      singleAgent: true,
      projects: true,
    });

    clerk.session(userId, retainedOrg, "org:member");
    const optedIn = await accept(
      client().update({
        headers,
        body: { switches: { [FeatureSwitchKey.SingleAgent]: true } },
      }),
      [200],
    );
    expect(optedIn.body.effectiveSwitches).toMatchObject({
      singleAgent: true,
      projects: true,
    });
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

  it("defaults three-point timing on only for its owner and retains personal opt-out and opt-in", async () => {
    const api = (
      await setupApp({
        context,
        routes: featureSwitchesRoutes,
        isolatePg: true,
      })
    )(featureSwitchesContract);
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

  it("cannot grant three-point timing to an unrelated same-staff-org admin through a stored opt-in", async () => {
    const api = (
      await setupApp({
        context,
        routes: featureSwitchesRoutes,
        isolatePg: true,
      })
    )(featureSwitchesContract);
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const ownerId = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV";
    const orgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    const key = FeatureSwitchKey.ArtifactThreePointTiming;

    clerk.session(ownerId, orgId, "org:member");
    const owner = await accept(api.get({ headers }), [200]);
    expect(owner.body.effectiveSwitches).toMatchObject({ [key]: true });
    const optedOut = await accept(
      api.update({ headers, body: { switches: { [key]: false } } }),
      [200],
    );
    expect(optedOut.body.effectiveSwitches).toMatchObject({ [key]: false });

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
    expect(unchangedOwner.body.switches).toMatchObject({ [key]: false });
    expect(unchangedOwner.body.effectiveSwitches).toMatchObject({
      [key]: false,
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

  it("applies an org-scoped override consistently across one organization", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    clerk.session(userId, orgId, "org:member");
    const initial = await accept(client().get({ headers }), [200]);
    expect(
      initial.body.effectiveSwitches[FeatureSwitchKey.LarkIntegration],
    ).toBeFalsy();
    await accept(
      client().update({
        headers,
        body: { switches: { [FeatureSwitchKey.LarkIntegration]: true } },
      }),
      [200],
    );
    clerk.session(`user_${randomUUID()}`, orgId, "org:member");
    const peer = await accept(client().get({ headers }), [200]);
    expect(
      peer.body.effectiveSwitches[FeatureSwitchKey.LarkIntegration],
    ).toBeTruthy();
    clerk.session(userId, `org_${randomUUID()}`, "org:member");
    const elsewhere = await accept(client().get({ headers }), [200]);
    expect(
      elsewhere.body.effectiveSwitches[FeatureSwitchKey.LarkIntegration],
    ).toBeFalsy();
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

  it("returns registered switches while merging known overrides for a supported App", async () => {
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );
    const headers = {
      authorization: "Bearer clerk-session",
      [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
      [CLIENT_VERSION_HEADER]: webClientCompatibility.minimumSupportedVersion,
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
    expect(updated.body.effectiveSwitches).toMatchObject(expected);
    expect(Object.keys(updated.body.effectiveSwitches).sort()).toStrictEqual(
      [...Object.values(FeatureSwitchKey), "projects"].sort(),
    );
    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual(expected);
    expect(current.body.effectiveSwitches).toStrictEqual(
      updated.body.effectiveSwitches,
    );
  });

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
