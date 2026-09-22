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

  it("defaults subscription priority on for every organization and applies overrides consistently across one", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const userId = `user_${randomUUID()}`;
    clerk.session(userId, "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", "org:member");
    const staff = await accept(client().get({ headers }), [200]);
    expect(
      staff.body.effectiveSwitches[
        FeatureSwitchKey.PersonalSubscriptionPriority
      ],
    ).toBeTruthy();
    const orgId = `org_${randomUUID()}`;
    clerk.session(userId, orgId, "org:member");
    const ordinary = await accept(client().get({ headers }), [200]);
    expect(
      ordinary.body.effectiveSwitches[
        FeatureSwitchKey.PersonalSubscriptionPriority
      ],
    ).toBeTruthy();
    await accept(
      client().update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.PersonalSubscriptionPriority]: false },
        },
      }),
      [200],
    );
    const peerUserId = `user_${randomUUID()}`;
    clerk.session(peerUserId, orgId, "org:member");
    const peer = await accept(client().get({ headers }), [200]);
    expect(
      peer.body.effectiveSwitches[
        FeatureSwitchKey.PersonalSubscriptionPriority
      ],
    ).toBeFalsy();
    clerk.session(userId, `org_${randomUUID()}`, "org:member");
    const elsewhere = await accept(client().get({ headers }), [200]);
    expect(
      elsewhere.body.effectiveSwitches[
        FeatureSwitchKey.PersonalSubscriptionPriority
      ],
    ).toBeTruthy();
    clerk.session(peerUserId, orgId, "org:member");
    await accept(
      client().update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.PersonalSubscriptionPriority]: true },
        },
      }),
      [200],
    );
    clerk.session(userId, orgId, "org:member");
    const restored = await accept(client().get({ headers }), [200]);
    expect(
      restored.body.effectiveSwitches[
        FeatureSwitchKey.PersonalSubscriptionPriority
      ],
    ).toBeTruthy();
  });

  it.each([true, false])(
    "echoes and persists a stored override as %s for a non-staff org",
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
              [FeatureSwitchKey.PersonalSubscriptionPriority]: enabled,
            },
          },
        }),
        [200],
      );

      expect(updated.body.switches).toStrictEqual({
        [FeatureSwitchKey.PersonalSubscriptionPriority]: enabled,
      });
      expect(
        updated.body.effectiveSwitches[
          FeatureSwitchKey.PersonalSubscriptionPriority
        ],
      ).toBe(enabled);

      const current = await accept(client().get({ headers }), [200]);
      expect(current.body.switches).toStrictEqual({
        [FeatureSwitchKey.PersonalSubscriptionPriority]: enabled,
      });
      expect(
        current.body.effectiveSwitches[
          FeatureSwitchKey.PersonalSubscriptionPriority
        ],
      ).toBe(enabled);
    },
  );
});
