import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

function accountsClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

function headersFor(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function readDetail(
  actor: ApiTestUser,
  connectionId: string,
  connectorSlug: ConnectorSlug,
) {
  return await accept(
    accountsClient().connection({
      headers: headersFor(actor),
      params: { connectionId },
      query: { kind: "builtin", connectorSlug },
    }),
    [200, 404],
  );
}

async function connectOpenAi(actor: ApiTestUser, apiKey: string) {
  return await createConnectorBddApi(context).connectManualGrant(
    actor,
    "openai",
    "api-token",
    { apiKey },
  );
}

describe("GET /api/connector-accounts/:connectionId", () => {
  it("connector-account-detail-003 returns the OpenAI account the owner just connected", async () => {
    const owner = createBddApi(context).user();
    const connected = await connectOpenAi(owner, `sk-${randomUUID()}`);

    const response = await readDetail(owner, connected.id, "openai");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: connected.id,
      target: { kind: "builtin", connectorSlug: "openai" },
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("connector-account-detail-005 only shows the account to its owner, organization and connector", async () => {
    const bdd = createBddApi(context);
    const owner = bdd.user();
    const connected = await connectOpenAi(owner, `sk-${randomUUID()}`);
    const sameOrgMember = bdd.user({
      orgId: owner.orgId,
      orgRole: "org:member",
    });
    const ownerElsewhere = bdd.user({ userId: owner.userId });

    const first = await readDetail(owner, connected.id, "openai");
    const wrongConnector = await readDetail(owner, connected.id, "github");
    const otherUser = await readDetail(sameOrgMember, connected.id, "openai");
    const otherOrg = await readDetail(ownerElsewhere, connected.id, "openai");
    const again = await readDetail(owner, connected.id, "openai");

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body).toStrictEqual(first.body);
    expect(wrongConnector.status).toBe(404);
    expect(otherUser.status).toBe(404);
    expect(otherOrg.status).toBe(404);
    expect(otherUser.body).toStrictEqual(wrongConnector.body);
    expect(otherOrg.body).toStrictEqual(wrongConnector.body);
  });

  it("connector-account-detail-006 reflects rename, deletion and a replacement connection", async () => {
    const owner = createBddApi(context).user();
    const connectors = createConnectorBddApi(context);
    const original = await connectOpenAi(owner, `sk-${randomUUID()}`);
    const target = { kind: "builtin", connectorSlug: "openai" } as const;

    const before = await readDetail(owner, original.id, "openai");
    expect(before.status).toBe(200);

    const renamed = await accept(
      accountsClient().rename({
        headers: headersFor(owner),
        params: { connectionId: original.id },
        body: { target, displayName: "Research key" },
      }),
      [200],
    );
    const afterRename = await readDetail(owner, original.id, "openai");
    expect(afterRename.status).toBe(200);
    expect(afterRename.body).toStrictEqual({
      ...before.body,
      displayName: "Research key",
      updatedAt: renamed.body.updatedAt,
    });

    await connectors.deleteBuiltinConnectorAccount(
      owner,
      "openai",
      original.id,
    );
    const afterDelete = await readDetail(owner, original.id, "openai");
    expect(afterDelete.status).toBe(404);
    expect(afterDelete.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    const replacement = await connectOpenAi(owner, `sk-${randomUUID()}`);
    expect(replacement.id).not.toBe(original.id);
    const replacementDetail = await readDetail(owner, replacement.id, "openai");
    expect(replacementDetail.status).toBe(200);
    expect(replacementDetail.body).toMatchObject({
      id: replacement.id,
      target,
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });
});
