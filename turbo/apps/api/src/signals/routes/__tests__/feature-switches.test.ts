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
  it("keeps subscription priority off for staff and applies overrides consistently across an organization", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const userId = `user_${randomUUID()}`;
    clerk.session(userId, "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", "org:member");
    const staff = await accept(client().get({ headers }), [200]);
    expect(
      staff.body.effectiveSwitches[
        FeatureSwitchKey.PersonalSubscriptionPriority
      ],
    ).toBeFalsy();
    const orgId = `org_${randomUUID()}`;
    clerk.session(userId, orgId, "org:member");
    const ordinary = await accept(client().get({ headers }), [200]);
    expect(
      ordinary.body.effectiveSwitches[
        FeatureSwitchKey.PersonalSubscriptionPriority
      ],
    ).toBeFalsy();
    await accept(
      client().update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.PersonalSubscriptionPriority]: true },
        },
      }),
      [200],
    );
    clerk.session(`user_${randomUUID()}`, orgId, "org:member");
    const peer = await accept(client().get({ headers }), [200]);
    expect(
      peer.body.effectiveSwitches[
        FeatureSwitchKey.PersonalSubscriptionPriority
      ],
    ).toBeTruthy();
    clerk.session(userId, `org_${randomUUID()}`, "org:member");
    const elsewhere = await accept(client().get({ headers }), [200]);
    expect(
      elsewhere.body.effectiveSwitches[
        FeatureSwitchKey.PersonalSubscriptionPriority
      ],
    ).toBeFalsy();
  });

  it("enables SSH by default only in the staff organization", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    const userId = `user_${randomUUID()}`;

    clerk.session(userId, "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", "org:member");
    const staff = await accept(client().get({ headers }), [200]);
    expect(
      staff.body.effectiveSwitches[FeatureSwitchKey.SshAccess],
    ).toBeTruthy();

    clerk.session(userId, `org_${randomUUID()}`, "org:member");
    const ordinary = await accept(client().get({ headers }), [200]);
    expect(
      ordinary.body.effectiveSwitches[FeatureSwitchKey.SshAccess],
    ).toBeFalsy();
  });

  it("defaults model selection refactoring to Bingjie and the staff org while excluding other orgs", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    clerk.session(
      "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
      `org_${randomUUID()}`,
      "org:member",
    );
    const owner = await accept(client().get({ headers }), [200]);
    expect(owner.body.effectiveSwitches[FeatureSwitchKey.Effort]).toBeTruthy();

    const staffUserId = `user_${randomUUID()}`;
    clerk.session(staffUserId, "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", "org:member");
    const staff = await accept(client().get({ headers }), [200]);
    expect(staff.body.effectiveSwitches[FeatureSwitchKey.Effort]).toBeTruthy();

    clerk.session(staffUserId, `org_${randomUUID()}`, "org:member");
    const nonStaffOrg = await accept(client().get({ headers }), [200]);
    expect(
      nonStaffOrg.body.effectiveSwitches[FeatureSwitchKey.Effort],
    ).toBeFalsy();
  });

  it.each([true, false])(
    "persists the unified model selection override as %s for a non-staff org",
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
              [FeatureSwitchKey.Effort]: enabled,
            },
          },
        }),
        [200],
      );

      expect(updated.body.switches).toStrictEqual({
        [FeatureSwitchKey.Effort]: enabled,
      });
      expect(updated.body.effectiveSwitches[FeatureSwitchKey.Effort]).toBe(
        enabled,
      );

      const current = await accept(client().get({ headers }), [200]);
      expect(current.body.switches).toStrictEqual({
        [FeatureSwitchKey.Effort]: enabled,
      });
      expect(current.body.effectiveSwitches[FeatureSwitchKey.Effort]).toBe(
        enabled,
      );
    },
  );
});
