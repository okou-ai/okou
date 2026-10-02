import { randomUUID } from "node:crypto";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { featureSwitchesRoutes } from "../feature-switches";

const context = testContext();

function client() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}

describe("/api/feature-switches", () => {
  it("keeps a personal switch personal within one organization", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const orgId = `org_${randomUUID()}`;
    const enabledUserId = `user_${randomUUID()}`;
    clerk.session(enabledUserId, orgId, "org:member");

    const enabled = await accept(
      client().update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.DeepSeekAlternativeRouting]: true },
        },
      }),
      [200],
    );
    expect(
      enabled.body.effectiveSwitches[
        FeatureSwitchKey.DeepSeekAlternativeRouting
      ],
    ).toBeTruthy();

    clerk.session(`user_${randomUUID()}`, orgId, "org:member");
    const peer = await accept(client().get({ headers }), [200]);
    expect(
      peer.body.effectiveSwitches[FeatureSwitchKey.DeepSeekAlternativeRouting],
    ).toBeFalsy();

    clerk.session(enabledUserId, orgId, "org:member");
    const original = await accept(client().get({ headers }), [200]);
    expect(
      original.body.effectiveSwitches[
        FeatureSwitchKey.DeepSeekAlternativeRouting
      ],
    ).toBeTruthy();
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
            switches: { [FeatureSwitchKey.DeepSeekAlternativeRouting]: true },
          },
        }),
        [200],
      ),
      accept(
        api.update({
          headers,
          body: { switches: { [FeatureSwitchKey.OpenRouterUsRouting]: false } },
        }),
        [200],
      ),
    ]);
    const current = await accept(api.get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual({
      [FeatureSwitchKey.DeepSeekAlternativeRouting]: true,
      [FeatureSwitchKey.OpenRouterUsRouting]: false,
    });
  });

  it("filters unknown keys while preserving unrelated overrides and replacing a requested key", async () => {
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );
    const headers = { authorization: "Bearer clerk-session" };
    await accept(
      client().update({
        headers,
        body: {
          switches: {
            [FeatureSwitchKey.DeepSeekAlternativeRouting]: true,
            [FeatureSwitchKey.OpenRouterUsRouting]: false,
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
            [FeatureSwitchKey.DeepSeekAlternativeRouting]: false,
            unregisteredFeature: true,
          },
        },
      }),
      [200],
    );
    const expected = {
      [FeatureSwitchKey.DeepSeekAlternativeRouting]: false,
      [FeatureSwitchKey.OpenRouterUsRouting]: false,
    };
    expect(updated.body.switches).toStrictEqual(expected);
    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual(expected);
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
            [FeatureSwitchKey.DeepSeekAlternativeRouting]: true,
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
            [FeatureSwitchKey.OpenRouterUsRouting]: true,
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
      [FeatureSwitchKey.OpenRouterUsRouting]: true,
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
            [FeatureSwitchKey.OpenRouterUsRouting]: true,
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
            [FeatureSwitchKey.DeepSeekAlternativeRouting]: false,
          },
        },
      }),
      [200],
    );
    expect(updated.body.switches).toStrictEqual({
      [FeatureSwitchKey.LarkIntegration]: true,
      [FeatureSwitchKey.DeepSeekAlternativeRouting]: false,
    });
    clerk.session(peerId, orgId, "org:member");
    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual({
      [FeatureSwitchKey.OpenRouterUsRouting]: true,
      [FeatureSwitchKey.LarkIntegration]: true,
    });
  });

  it("rejects the retired native override without applying other changes", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const userId = `user_${randomUUID()}`;
    clerk.session(userId, "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", "org:member");

    const initial = await accept(client().get({ headers }), [200]);
    expect(initial.body.switches).toStrictEqual({});

    const refused = await accept(
      client().update({
        headers,
        body: {
          switches: {
            simpleMorningBrief: true,
            [FeatureSwitchKey.DeepSeekAlternativeRouting]: true,
          },
        },
      }),
      [400],
    );
    expect(refused.body.error.code).toBe("BAD_REQUEST");
    const afterRefusal = await accept(client().get({ headers }), [200]);
    expect(afterRefusal.body.switches).toStrictEqual({});

    const optedOut = await accept(
      client().update({
        headers,
        body: { switches: { simpleMorningBrief: false } },
      }),
      [200],
    );
    // Retired values are not exposed through the registered-key response.
    expect(optedOut.body.switches).toStrictEqual({});
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
