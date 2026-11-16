import { randomUUID } from "node:crypto";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { expect, onTestFinished, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockDatadogConnectorOAuth,
  mockGitHubConnectorOAuth,
  mockGmailConnectorOAuth,
  mockGoogleDriveConnectorOAuth,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { readGetStartedStatus } from "./helpers/get-started";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const mocks = createRouteMocks(context);

const connectorSlugs = [
  "gmail",
  "google-drive",
  "google-forms",
  "google-calendar",
  "google-analytics",
  "google-ads",
  "google-maps",
  "google-sheets",
  "google-meet",
  "github",
  "slack",
  "datadog",
] as const;

async function connect(
  actor: ApiTestUser,
  slug: (typeof connectorSlugs)[number],
) {
  const start = await connectors.startOauth(actor, slug, "oauth");
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector OAuth state");
  }
  await connectors.completeOauthCallback(slug, {
    code: `reward-${randomUUID()}`,
    state,
    ...(slug === "datadog" ? { domain: "us3.datadoghq.com" } : {}),
  });
  const connection = await connectors.readDefaultBuiltinAccount(actor, slug);
  onTestFinished(async () => {
    await connectors.deleteBuiltinConnectorAccount(actor, slug, connection.id);
  });
  return connection;
}

test("connector rewards stop at ten across concurrent connections, organizations, and reward expiry", async () => {
  const actor = bdd.user();
  mockNow(new Date("2026-11-16T08:00:00.000Z"));
  mockGmailConnectorOAuth();
  mockGoogleDriveConnectorOAuth();
  mockGitHubConnectorOAuth();
  mockSlackConnectorOAuth();
  mockDatadogConnectorOAuth();
  await Promise.all(
    connectorSlugs.slice(0, 8).map((slug) => {
      return connect(actor, slug);
    }),
  );
  expect((await readGetStartedStatus(context, actor)).quests).toContainEqual(
    expect.objectContaining({
      key: "connector",
      claimedCount: 8,
      limit: 10,
      earnedCredits: 800,
      canEarnMore: true,
    }),
  );

  // Four different connections compete for the final two rewards. Every
  // connection must succeed in a second organization, while only two
  // additional personal grants can publish.
  const anotherOrg = { ...actor, orgId: `org_${randomUUID()}` };
  await Promise.all(
    connectorSlugs.slice(8).map((slug) => {
      return connect(anotherOrg, slug);
    }),
  );
  const capped = await readGetStartedStatus(context, actor);
  expect(capped.quests).toContainEqual(
    expect.objectContaining({
      key: "connector",
      claimedCount: 10,
      limit: 10,
      earnedCredits: 1000,
      canEarnMore: false,
    }),
  );
  for (const [owner, amount, grants] of [
    [actor, 800, 8],
    [anotherOrg, 200, 2],
  ] as const) {
    mocks.clerk.session(owner.userId, owner.orgId, owner.orgRole);
    const credits = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(credits.body.bonusCredits).toBe(amount);
    expect(credits.body.creditGrants).toHaveLength(grants);
  }

  mockNow(new Date("2026-11-24T08:00:00.000Z"));
  const thirdOrg = { ...actor, orgId: `org_${randomUUID()}` };
  await Promise.all(
    connectorSlugs.slice(8).map((slug) => {
      return connect(thirdOrg, slug);
    }),
  );
  const afterOrgSwitch = await readGetStartedStatus(context, thirdOrg);
  expect(afterOrgSwitch.quests).toContainEqual(
    expect.objectContaining({
      key: "connector",
      claimedCount: 10,
      canEarnMore: false,
    }),
  );
  expect(afterOrgSwitch.recentGrants).toStrictEqual([]);

  // Another user in the same organization has their own allowance.
  const anotherUser = { ...actor, userId: `user_${randomUUID()}` };
  await connect(anotherUser, connectorSlugs[0]);
  expect(
    (await readGetStartedStatus(context, anotherUser)).quests,
  ).toContainEqual(
    expect.objectContaining({
      key: "connector",
      claimedCount: 1,
      earnedCredits: 100,
      canEarnMore: true,
    }),
  );
});
