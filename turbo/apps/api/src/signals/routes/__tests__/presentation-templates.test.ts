import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { presentationTemplatesRoutes } from "../presentation-templates";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);

function webHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function templateClient() {
  return setupApp({ context, routes: presentationTemplatesRoutes })(
    presentationTemplatesContract,
  );
}

beforeEach(() => {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", "test-user-artifacts");
});

describe("presentation template owner routes", () => {
  it("lists the owner collection", async () => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId);
    const client = templateClient();

    const response = await accept(
      client.list({ headers: webHeaders() }),
      [200],
    );
    expect(response.body).toStrictEqual([]);
  });
});
