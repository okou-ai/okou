import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import type { ApplyUserPermissionGrant } from "@okouai/api-contracts/validators/user-permission-grants";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const mocks = createRouteMocks(context);
const headers = { authorization: "Bearer clerk-session" } as const;
const startedAt = Date.parse("2026-11-05T00:00:00.000Z");
const hour = 60 * 60 * 1000;

async function owner() {
  const actor = bdd.user();
  mockSlackConnectorOAuth();
  const started = await connectors.startOauth(actor, "slack", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state from the public start response");
  }
  const completed = await connectors.completeOauthCallbackResult("slack", {
    state,
    code: randomUUID(),
  });
  expect(completed.body.status).toBe("success");

  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return async (
    grant: ApplyUserPermissionGrant,
    mode: "patch" | "replace" = "patch",
  ) => {
    const result = await accept(
      setupApp({ context, routes: connectorPermissionsRoutes })(
        connectorPermissionsContract,
      ).apply({
        headers,
        body: {
          target: { kind: "builtin", connectorSlug: "slack" },
          mode,
          grants: [grant],
        },
      }),
      [200],
    );
    return result.body.grants;
  };
}

describe("Connector permission expiration", () => {
  it("preserves a patch deadline unless the caller explicitly changes the duration or replaces the grant", async () => {
    mockNow(startedAt);
    const apply = await owner();
    const allow = { permission: "chat:write", action: "allow" } as const;
    await expect(apply({ ...allow, expiresIn: "1h" })).resolves.toMatchObject([
      { expiresAt: new Date(startedAt + hour).toISOString() },
    ]);
    mockNow(startedAt + 10 * 60 * 1000);
    await expect(apply(allow)).resolves.toMatchObject([
      { expiresAt: new Date(startedAt + hour).toISOString() },
    ]);
    await expect(apply({ ...allow, expiresIn: "24h" })).resolves.toMatchObject([
      {
        expiresAt: new Date(
          startedAt + 10 * 60 * 1000 + 24 * hour,
        ).toISOString(),
      },
    ]);
    await expect(
      apply({ ...allow, expiresIn: "always" }),
    ).resolves.toMatchObject([{ expiresAt: null }]);
    await apply({ ...allow, expiresIn: "1h" });
    await expect(apply(allow, "replace")).resolves.toMatchObject([
      { expiresAt: null },
    ]);
  });

  it("clears expiry on deny and does not preserve an already expired allow deadline", async () => {
    mockNow(startedAt);
    const apply = await owner();
    const allow = { permission: "chat:write", action: "allow" } as const;
    await apply({ ...allow, expiresIn: "1h" });
    await expect(
      apply({ permission: "chat:write", action: "deny" }),
    ).resolves.toMatchObject([{ action: "deny", expiresAt: null }]);
    await apply({ ...allow, expiresIn: "1h" });
    mockNow(startedAt + hour);
    await expect(apply(allow)).resolves.toMatchObject([
      { action: "allow", expiresAt: null },
    ]);
  });
});
