import { randomUUID } from "node:crypto";

import { builtinConnectorsSearchContract } from "@okouai/api-contracts/contracts/connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { builtinConnectorsRoutes } from "../connectors";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

interface Member {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: "org:admin" | "org:member";
}

function newMember(orgRole: Member["orgRole"] = "org:admin"): Member {
  return {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    orgRole,
  };
}

async function search(member: Member, keyword?: string) {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    member.orgRole,
  );
  const client = setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorsSearchContract,
  );
  const response = await accept(
    client.search({
      headers: { authorization: "Bearer clerk-session" },
      query: keyword === undefined ? {} : { keyword },
    }),
    [200],
  );
  return response.body.connectors;
}

function authMethodsOf(
  connectors: Awaited<ReturnType<typeof search>>,
  slug: string,
) {
  return connectors.find((connector) => {
    return connector.slug === slug;
  })?.authMethods;
}

describe("GET /api/connectors/search", () => {
  it("connectors-search-002 lists between 1 and 100 connectors without a keyword", async () => {
    const connectors = await search(newMember());

    expect(connectors.length).toBeGreaterThanOrEqual(1);
    expect(connectors.length).toBeLessThanOrEqual(100);
  });

  it("connectors-search-003 filters connectors by a keyword matching slug or label", async () => {
    const connectors = await search(newMember(), "GitHub");

    expect(connectors.length).toBeGreaterThanOrEqual(1);
    for (const connector of connectors) {
      const matches =
        connector.slug.toLowerCase().includes("github") ||
        connector.label.toLowerCase().includes("github");
      expect(matches).toBeTruthy();
    }
  });

  it("connectors-search-008 shows the test OAuth device connector once the member enables it", async () => {
    const member = newMember();
    await updateFeatureSwitchesForUser(context, member, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const connectors = await search(member, "test oauth device");

    expect(authMethodsOf(connectors, "test-oauth-device")).toStrictEqual([
      "oauth",
      "api",
    ]);
  });

  it("connectors-search-010 offers LinkedIn OAuth to an ordinary workspace member", async () => {
    const connectors = await search(newMember("org:member"), "linkedin");

    expect(authMethodsOf(connectors, "linkedin")).toStrictEqual(["oauth"]);
  });

  it("connectors-search-011 exposes OpenAI as api-token only", async () => {
    const connectors = await search(newMember());

    expect(authMethodsOf(connectors, "openai")).toStrictEqual(["api-token"]);
  });
});
