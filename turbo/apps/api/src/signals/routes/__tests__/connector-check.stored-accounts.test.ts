import { randomUUID } from "node:crypto";
import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorCheckContract,
  type ConnectorCheckRequestBody,
} from "@okouai/api-contracts/contracts/connector-check";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorCheckRoutes } from "../connector-check";
import { builtinConnectorsRoutes } from "../connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const REAP: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "reap",
});

interface Admin {
  readonly userId: string;
  readonly orgId: string;
}

function as(admin: Admin) {
  createRouteMocks(context).clerk.session(
    admin.userId,
    admin.orgId,
    "org:admin",
  );
  return { authorization: "Bearer clerk-session" };
}

async function saveReapAccount(admin: Admin, apiBaseUrl: string) {
  const response = await accept(
    setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    ).connect({
      params: { connectorSlug: "reap" },
      headers: as(admin),
      body: {
        authMethod: "api-token",
        values: { apiKey: `reap-key-${randomUUID()}`, apiBaseUrl },
        account: { intent: "add" },
      },
    }),
    [200],
  );
  return response.body.connectionId;
}

async function makeDefault(admin: Admin, connectionId: string) {
  await accept(
    setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    ).setDefault({
      headers: as(admin),
      params: { connectionId },
      body: { target: REAP },
    }),
    [200],
  );
}

async function diagnoseUsers(admin: Admin, base: string) {
  const body: ConnectorCheckRequestBody = {
    mode: "url",
    method: "GET",
    url: `${base}/users`,
    connectorSlug: "reap",
  };
  const response = await accept(
    setupApp({ context, routes: connectorCheckRoutes })(
      connectorCheckContract,
    ).check({ headers: as(admin), body }),
    [200],
  );
  return response.body;
}

function resolvedFor(base: string) {
  return {
    outcome: "resolved",
    base,
    relativePath: "/users",
    connector: { target: REAP },
    run: { status: "not-scoped" },
  };
}

/** An admin has two saved Reap accounts with distinct base URLs. */
async function twoReapAccounts() {
  const admin = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  const baseA = `https://reap-${randomUUID()}.example.org`;
  const baseB = `https://reap-${randomUUID()}.example.org`;
  const first = await saveReapAccount(admin, baseA);
  const second = await saveReapAccount(admin, baseB);
  return { admin, baseA, baseB, first, second };
}

describe("stored Connector diagnostic account selection", () => {
  it("connector-check.stored-accounts-002 (1/2) resolves only the first account's base while it is the default", async () => {
    const { admin, baseA, baseB, first, second } = await twoReapAccounts();

    await makeDefault(admin, first);
    const current = await diagnoseUsers(admin, baseA);
    const other = await diagnoseUsers(admin, baseB);

    expect(current).toMatchObject(resolvedFor(baseA));
    expect(other).toStrictEqual({ outcome: "no-match", scope: "catalog" });
    const serialized = JSON.stringify([current, other]);
    expect(serialized).not.toContain(first);
    expect(serialized).not.toContain(second);
  });

  it("connector-check.stored-accounts-002 (2/2) follows the default to the second account's base", async () => {
    const { admin, baseA, baseB, first, second } = await twoReapAccounts();
    await makeDefault(admin, first);

    await makeDefault(admin, second);
    const current = await diagnoseUsers(admin, baseB);
    const other = await diagnoseUsers(admin, baseA);

    expect(current).toMatchObject(resolvedFor(baseB));
    expect(other).toStrictEqual({ outcome: "no-match", scope: "catalog" });
    const serialized = JSON.stringify([current, other]);
    expect(serialized).not.toContain(first);
    expect(serialized).not.toContain(second);
  });
});
