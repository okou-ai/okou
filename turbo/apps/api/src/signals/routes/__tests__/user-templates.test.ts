import { randomUUID } from "node:crypto";

import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { userTemplatesRoutes } from "../user-templates";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);

function webHeaders() {
  return { authorization: "Bearer clerk-session" };
}

/** Signs in a member and turns the switch on for them. */
async function enabledActor() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("User template tests require an organization");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
    { [FeatureSwitchKey.CustomTemplates]: true },
  );
  return actor;
}

function templateClient() {
  return setupApp({ context, routes: userTemplatesRoutes })(
    userTemplatesContract,
  );
}

beforeEach(() => {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", "test-user-artifacts");
});

describe("user template owner routes", () => {
  it("lists an empty catalog for a member with no templates", async () => {
    await enabledActor();
    const client = templateClient();

    const response = await accept(
      client.list({ headers: webHeaders() }),
      [200],
    );
    expect(response.body).toStrictEqual([]);
  });

  it("does not expose an unknown template through owner routes", async () => {
    await enabledActor();
    const client = templateClient();
    const templateId = randomUUID();

    const readResponse = await accept(
      client.get({ headers: webHeaders(), params: { templateId } }),
      [404],
    );
    const updateResponse = await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId },
        body: { title: "Renamed" },
      }),
      [404],
    );
    const deleteResponse = await accept(
      client.delete({ headers: webHeaders(), params: { templateId } }),
      [404],
    );

    // The same answer for every verb: a caller cannot tell an inaccessible
    // template from one that never existed.
    const notFoundBody = {
      error: {
        message: `User template not found: ${templateId}`,
        code: "NOT_FOUND",
      },
    };
    expect([
      readResponse.body,
      updateResponse.body,
      deleteResponse.body,
    ]).toStrictEqual([notFoundBody, notFoundBody, notFoundBody]);
  });

  it("hides the catalog entirely while the switch is off", async () => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId);
    const client = templateClient();

    // Reads are gated too: with the switch off the feature must be absent, not
    // merely read-only.
    const response = await accept(
      client.list({ headers: webHeaders() }),
      [403],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Custom templates are not enabled",
        code: "FORBIDDEN",
      },
    });
  });

  it("resolves no assets for preview ids that match nothing", async () => {
    await enabledActor();
    const client = templateClient();

    // A well-formed id for a template this caller cannot reach must resolve to
    // nothing rather than to a URL.
    const response = await accept(
      client.resolvePreviewUrls({
        headers: webHeaders(),
        body: {
          previewAssetIds: [`utp:${randomUUID()}:${"a".repeat(43)}`],
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ assets: [] });
  });
});
