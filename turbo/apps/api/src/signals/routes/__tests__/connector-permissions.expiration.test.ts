import { randomUUID } from "node:crypto";
import {
  connectorPermissionsContract,
  type ApplyConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const permissionsApi = setupApp({
  context,
  routes: connectorPermissionsRoutes,
})(connectorPermissionsContract);

const START = Date.parse("2026-06-01T08:00:00.000Z");
const LATER = START + 10 * 60 * 1000;
const START_PLUS_1H_ISO = "2026-06-01T09:00:00.000Z";
const LATER_PLUS_24H_ISO = "2026-06-02T08:10:00.000Z";
const LATER_PLUS_1H_ISO = "2026-06-01T09:10:00.000Z";
const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const SLACK_TARGET: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "slack",
});

async function connectSlack(actor: ApiTestUser): Promise<void> {
  mockSlackConnectorOAuth();
  const started = await connectors.startOauth(actor, "slack", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Slack authorization state");
  }
  const completed = await connectors.completeOauthCallbackResult("slack", {
    state,
    code: `code-${randomUUID()}`,
  });
  expect(completed.body.status).toBe("success");
}

/** Applies one chat:write allow rule and returns its resulting deadline. */
async function applyChatWrite(
  actor: ApiTestUser,
  mode: ApplyConnectorPermissions["mode"],
  expiresIn?: "1h" | "24h" | "always",
): Promise<string | null | undefined> {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const response = await accept(
    permissionsApi.apply({
      headers: AUTH_HEADERS,
      body: {
        target: SLACK_TARGET,
        mode,
        grants: [
          {
            permission: "chat:write",
            action: "allow",
            ...(expiresIn ? { expiresIn } : {}),
          },
        ],
      },
    }),
    [200],
  );
  return response.body.grants.find((grant) => {
    return grant.permission === "chat:write";
  })?.expiresAt;
}

/** The owner completed Slack OAuth with no prior chat:write expiry. */
async function slackOwner(): Promise<ApiTestUser> {
  mockNow(START);
  const owner = bdd.user();
  await connectSlack(owner);
  return owner;
}

describe("Connector permission expiration", () => {
  it("connector-permissions.expiration-001 (1/3) keeps the one-hour patch deadline on a durationless revisit", async () => {
    const owner = await slackOwner();

    const first = await applyChatWrite(owner, "patch", "1h");
    mockNow(LATER);
    const durationless = await applyChatWrite(owner, "patch");

    expect(first).toBe(START_PLUS_1H_ISO);
    expect(durationless).toBe(first);
  });

  it("connector-permissions.expiration-001 (2/3) recomputes the deadline for explicit 24h and clears it on always", async () => {
    const owner = await slackOwner();
    await applyChatWrite(owner, "patch", "1h");
    mockNow(LATER);

    const day = await applyChatWrite(owner, "patch", "24h");
    const always = await applyChatWrite(owner, "patch", "always");

    expect(day).toBe(LATER_PLUS_24H_ISO);
    expect(always).toBeNull();
  });

  it("connector-permissions.expiration-001 (3/3) clears a renewed one-hour deadline on a durationless replace", async () => {
    const owner = await slackOwner();
    mockNow(LATER);

    const renewed = await applyChatWrite(owner, "patch", "1h");
    const replaced = await applyChatWrite(owner, "replace");

    expect(renewed).toBe(LATER_PLUS_1H_ISO);
    expect(replaced).toBeNull();
  });
});
