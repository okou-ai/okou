import { randomUUID } from "node:crypto";

import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { modelCatalogRoutes } from "../model-catalog";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { countPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
// The staff organization identity only selects the production staff gate;
// every case uses its own members inside it.
const staffOrgId = createUniqueStaffOrgIdFixture();
const PILOT_EFFORTS = {
  "gemini-4-neon": ["low", "medium", "high", "xhigh"],
  "gemini-4-carbon": ["low", "medium", "high"],
  "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
} as const;
const PILOT_MODELS = Object.keys(PILOT_EFFORTS);

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

async function readCatalog(member: Member) {
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  const response = await accept(
    setupApp({ context, routes: modelCatalogRoutes })(modelCatalogContract).get(
      { headers: { authorization: "Bearer clerk-session" } },
    ),
    [200],
  );
  return response.body;
}

async function pilotModelsSeenBy(member: Member) {
  const catalog = await readCatalog(member);
  return [
    ...catalog.models.map((row) => {
      return row.model;
    }),
    ...catalog.routes.map((route) => {
      return route.model;
    }),
  ].filter((model) => {
    return PILOT_MODELS.includes(model);
  });
}

describe("staff Antigravity model catalog", () => {
  it("model-catalog-antigravity-001 shows the three pilot models only to the opted-in staff member", async () => {
    const member = { userId: `user_${randomUUID()}`, orgId: staffOrgId };
    const peer = { userId: `user_${randomUUID()}`, orgId: staffOrgId };
    const outsideStaff = {
      userId: member.userId,
      orgId: `org_${randomUUID()}`,
    };
    await expect(pilotModelsSeenBy(member)).resolves.toStrictEqual([]);

    await updateFeatureSwitchesForUser(context, member, {
      [FeatureSwitchKey.GeminiAntigravity]: true,
    });
    await flushWaitUntilForTest();

    expect(
      countPublishedTo(context.mocks, {
        channel: `user:${member.userId}`,
        topic: "runModelsChanged",
      }),
    ).toBe(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "runModelsChanged",
      null,
    );
    await expect(pilotModelsSeenBy(peer)).resolves.toStrictEqual([]);
    await expect(pilotModelsSeenBy(outsideStaff)).resolves.toStrictEqual([]);

    const catalog = await readCatalog(member);
    expect(
      catalog.models
        .filter((row) => {
          return PILOT_MODELS.includes(row.model);
        })
        .map((row) => {
          return row.displayName;
        }),
    ).toStrictEqual(["Gemini 4 Neon", "Gemini 4 Carbon", "Gemini 4 Hydrogen"]);
    for (const [model, efforts] of Object.entries(PILOT_EFFORTS)) {
      const routes = catalog.routes.filter((route) => {
        return route.model === model;
      });
      // Current production (#50982) enables the routes for opted-in staff.
      expect(routes).toStrictEqual([
        expect.objectContaining({
          providerType: "antigravity",
          subscriptionType: "antigravity",
          upstreamModel: model,
          enabled: true,
          serviceTiers: [],
          defaultServiceTier: null,
          efforts,
          defaultEffort: "medium",
          piRuntimeCapable: false,
        }),
      ]);
    }
  });
});
