import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { modelCatalogRoutes } from "../model-catalog";
import { runModelsRoutes } from "../run-models";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const clerk = createRouteMocks(context).clerk;
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const key = FeatureSwitchKey.GeminiAntigravity;
const models: readonly string[] = Object.freeze([
  "gemini-4-neon",
  "gemini-4-carbon",
  "gemini-4-hydrogen",
]);

async function pilotCatalog() {
  const client = setupApp({ context, routes: modelCatalogRoutes })(
    modelCatalogContract,
  );
  const { body } = await accept(client.get({ headers }), [200]);
  return {
    models: body.models.filter((entry) => {
      return models.includes(entry.model);
    }),
    routes: body.routes.filter((route) => {
      return models.includes(route.model);
    }),
  };
}

describe("staff Antigravity model catalog", () => {
  it("shows the three models and their effort options only to the opted-in member", async () => {
    const staff = {
      orgId: createUniqueStaffOrgIdFixture(),
      userId: `user_${randomUUID()}`,
    };
    const hidden = { models: [], routes: [] };
    clerk.session(staff.userId, staff.orgId, "org:member");
    await expect(pilotCatalog()).resolves.toStrictEqual(hidden);
    await updateFeatureSwitchesForUser(context, staff, { [key]: true });
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `user:${staff.userId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "runModelsChanged",
      null,
    );
    const pilot = await pilotCatalog();
    expect(
      pilot.models.map((row) => {
        return row.model;
      }),
    ).toStrictEqual(models);
    expect(pilot.routes).toHaveLength(3);
    for (const model of models) {
      expect(pilot.routes).toContainEqual(
        expect.objectContaining({
          model,
          upstreamModel: model,
          providerType: "antigravity",
          subscriptionType: "antigravity",
          concreteProviderType: "antigravity",
          enabled: false,
          defaultEffort: "medium",
          efforts:
            model === "gemini-4-carbon"
              ? ["low", "medium", "high"]
              : ["low", "medium", "high", "xhigh"],
          serviceTiers: [],
          piRuntimeCapable: false,
        }),
      );
    }
    clerk.session(`user_${randomUUID()}`, staff.orgId, "org:member");
    await expect(pilotCatalog()).resolves.toStrictEqual(hidden);
    clerk.session(staff.userId, `org_${randomUUID()}`, "org:admin");
    await expect(pilotCatalog()).resolves.toStrictEqual(hidden);
    await updateFeatureSwitchesForUser(context, staff, { [key]: false });
    await expect(pilotCatalog()).resolves.toStrictEqual(hidden);
  });

  it("keeps an unbound Google selection out of runnable models and rejects a direct thread request", async () => {
    const staff = {
      orgId: createUniqueStaffOrgIdFixture(),
      userId: `user_${randomUUID()}`,
    };
    const threads = setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    );
    const available = setupApp({ context, routes: runModelsRoutes })(
      runModelsMainContract,
    );
    clerk.session(staff.userId, staff.orgId, "org:member");
    const denied = await accept(
      threads.create({ headers, body: { model: "gemini-4-neon" } }),
      [400],
    );
    expect(denied.body.error.message).toBe(
      "Select Auto or a model from your connected personal subscription",
    );
    await updateFeatureSwitchesForUser(context, staff, { [key]: true });
    const { body } = await accept(available.list({ headers }), [200]);
    expect(
      body.models.map((entry) => {
        return entry.model;
      }),
    ).toStrictEqual(["auto"]);
    for (const model of models) {
      const response = await accept(
        threads.create({ headers, body: { model } }),
        [400],
      );
      expect(response.body.error.message).toBe(
        "This model requires a connected personal Google AI subscription.",
      );
    }
  });
});
