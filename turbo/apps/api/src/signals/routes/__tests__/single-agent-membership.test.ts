import { randomUUID } from "node:crypto";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { featureSwitchesRoutes } from "../feature-switches";
import { userPreferencesRoutes } from "../user-preferences";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const org = createAuthOrgAgentsBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function member(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected a workspace member");
  }
  return { ...actor, orgId: actor.orgId };
}

async function initialize(actor: ApiTestUser) {
  org.authenticate(actor);
  await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers,
      body: { timezone: "Asia/Shanghai", locale: "en-US" },
    }),
    [200],
  );
}

async function switches(actor: ApiTestUser) {
  org.authenticate(actor);
  const response = await accept(
    setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    ).get({ headers }),
    [200],
  );
  return response.body;
}

describe("Single Agent membership lifecycle", () => {
  it("defaults a new workspace to Single Agent for an existing account and retains its original choice", async () => {
    const existing = member(org.user());
    await initialize(existing);
    await updateFeatureSwitchesForUser(context, existing, {
      [FeatureSwitchKey.SingleAgent]: false,
    });
    // Retrying initialization must not erase an active member's choice.
    await initialize(existing);
    expect(
      (await switches(existing)).effectiveSwitches.singleAgent,
    ).toBeFalsy();

    const elsewhere = org.user({
      userId: existing.userId,
      email: existing.email,
    });
    await initialize(elsewhere);
    expect(
      (await switches(elsewhere)).effectiveSwitches.singleAgent,
    ).toBeTruthy();
    expect(
      (await switches(existing)).effectiveSwitches.singleAgent,
    ).toBeFalsy();
  });

  it.each(["leave", "remove", "webhook"] as const)(
    "uses the new default after %s and reinitialization while preserving other settings and memberships",
    async (departure) => {
      const departing = member(org.user({ orgRole: "org:member" }));
      const admin = member(org.user({ orgId: departing.orgId }));
      const elsewhere = member(
        org.user({ userId: departing.userId, email: departing.email }),
      );
      await initialize(departing);
      for (const actor of [departing, admin, elsewhere]) {
        await updateFeatureSwitchesForUser(context, actor, {
          [FeatureSwitchKey.SingleAgent]: false,
          [FeatureSwitchKey.Dummy]: false,
        });
      }
      org.mockClerkOrg(admin, {
        members: [
          { actor: admin, role: "org:admin" },
          { actor: departing, role: "org:member" },
        ],
      });
      if (departure === "leave") {
        await org.leaveOrg(departing);
      } else if (departure === "remove") {
        await org.removeMember(admin, { email: departing.email });
      } else {
        webhooks.configureClerkWebhookSecret();
        webhooks.verifyNextClerkWebhook({
          type: "organizationMembership.deleted",
          data: {
            id: `orgmem_${randomUUID()}`,
            organization_id: departing.orgId,
            user_id: departing.userId,
          },
        });
        await webhooks.requestClerkWebhook("{}", {}, [200]);
        await flushWaitUntilForTest();
        await flushWaitUntilForTest();
      }

      await initialize(departing);
      const rejoined = await switches(departing);
      expect(rejoined.switches).toStrictEqual({
        [FeatureSwitchKey.Dummy]: false,
      });
      expect(rejoined.effectiveSwitches.singleAgent).toBeTruthy();
      for (const actor of [admin, elsewhere]) {
        expect((await switches(actor)).switches).toStrictEqual({
          [FeatureSwitchKey.SingleAgent]: false,
          [FeatureSwitchKey.Dummy]: false,
        });
      }
    },
  );
});
