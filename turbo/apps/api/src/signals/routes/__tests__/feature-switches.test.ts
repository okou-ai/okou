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
  it("keeps the Okou Add Model switch personal within one organization", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const orgId = `org_${randomUUID()}`;
    const enabledUserId = `user_${randomUUID()}`;
    clerk.session(enabledUserId, orgId, "org:member");

    const enabled = await accept(
      client().update({
        headers,
        body: { switches: { [FeatureSwitchKey.OkouModels]: true } },
      }),
      [200],
    );
    expect(
      enabled.body.effectiveSwitches[FeatureSwitchKey.OkouModels],
    ).toBeTruthy();

    clerk.session(`user_${randomUUID()}`, orgId, "org:member");
    const peer = await accept(client().get({ headers }), [200]);
    expect(
      peer.body.effectiveSwitches[FeatureSwitchKey.OkouModels],
    ).toBeFalsy();

    clerk.session(enabledUserId, orgId, "org:member");
    const original = await accept(client().get({ headers }), [200]);
    expect(
      original.body.effectiveSwitches[FeatureSwitchKey.OkouModels],
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

  it("does not let staff or stored overrides re-enable the retiring native brief", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const userId = `user_${randomUUID()}`;
    clerk.session(userId, "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", "org:member");

    const initial = await accept(client().get({ headers }), [200]);
    expect(
      initial.body.effectiveSwitches[FeatureSwitchKey.NativeMorningBrief],
    ).toBeFalsy();
    expect(
      initial.body.effectiveSwitches[FeatureSwitchKey.MorningBrief],
    ).toBeTruthy();

    const refused = await accept(
      client().update({
        headers,
        body: {
          switches: {
            [FeatureSwitchKey.NativeMorningBrief]: true,
            [FeatureSwitchKey.OkouModels]: true,
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
        body: { switches: { [FeatureSwitchKey.NativeMorningBrief]: false } },
      }),
      [200],
    );
    expect(
      optedOut.body.effectiveSwitches[FeatureSwitchKey.NativeMorningBrief],
    ).toBeFalsy();
    expect(
      optedOut.body.effectiveSwitches[FeatureSwitchKey.MorningBrief],
    ).toBeTruthy();
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
