import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { automaticMcpCatalogFixture } from "./helpers/connector-automatic-catalog";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const connectors = createConnectorBddApi(context);
const store = createStore();
const automatic = setupApp({
  context,
  routes: builtinConnectorsAutomaticRoutes,
})(builtinConnectorAutomaticContract);

/** A member with a real membership in `orgId`. */
async function memberOf(userId: string, orgId: string): Promise<ApiTestUser> {
  await store.set(
    seedOrgMembership$,
    { userId, orgId, role: "member" },
    context.signal,
  );
  return {
    userId,
    orgId,
    orgRole: "org:member",
    email: `${userId}@example.test`,
  };
}

async function startAutomatic(
  actor: ApiTestUser,
  connectorSlug: string,
  account:
    | { readonly intent: "add" }
    | { readonly intent: "reconnect"; readonly connectionId: string },
  statuses: readonly (200 | 409)[],
) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return await accept(
    automatic.start({
      headers: { authorization: "Bearer clerk-session" },
      params: { connectorSlug },
      body: { authMethod: "smart-connect", account },
    }),
    statuses,
  );
}

describe("builtin Automatic account and consent ownership", () => {
  it("connectors-automatic-security-006 rejects reconnecting an account owned by another user or organization", async () => {
    const fixture = automaticMcpCatalogFixture("none");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
      endpoint: fixture.endpoint,
    });
    const workspaceId = `org_${randomUUID()}`;
    const owner = await memberOf(`user_${randomUUID()}`, workspaceId);
    const connected = await startAutomatic(
      owner,
      fixture.slug,
      { intent: "add" },
      [200],
    );
    if (
      !("result" in connected.body) ||
      connected.body.result !== "connected"
    ) {
      throw new Error("Expected the account to connect immediately");
    }
    const reconnect = {
      intent: "reconnect",
      connectionId: connected.body.connectionId,
    } as const;
    const peer = await memberOf(`user_${randomUUID()}`, workspaceId);
    const ownerElsewhere = await memberOf(owner.userId, `org_${randomUUID()}`);

    const peerAttempt = await startAutomatic(
      peer,
      fixture.slug,
      reconnect,
      [409],
    );
    const elsewhereAttempt = await startAutomatic(
      ownerElsewhere,
      fixture.slug,
      reconnect,
      [409],
    );

    expect(peerAttempt.status).toBe(409);
    expect(elsewhereAttempt.status).toBe(409);
    const account = await connectors.readBuiltinConnectorAccount(
      owner,
      fixture.slug,
      connected.body.connectionId,
    );
    expect(account.connectionStatus).toBe("connected");
  });
});
