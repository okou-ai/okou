import { randomUUID } from "node:crypto";

import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

const GITLAB: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "gitlab",
});

function newMember(): Member {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function as(member: Member) {
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  return { authorization: "Bearer clerk-session" };
}

function accounts() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

async function listConnectors(member: Member) {
  const client = setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorsMainContract,
  );
  const response = await accept(client.list({ headers: as(member) }), [200]);
  return response.body;
}

async function manualGrant(
  member: Member,
  connectorSlug: string,
  values: Record<string, string>,
) {
  const client = setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorManualGrantContract,
  );
  const response = await accept(
    client.connect({
      params: { connectorSlug },
      headers: as(member),
      body: { authMethod: "api-token", account: { intent: "add" }, values },
    }),
    [200],
  );
  return response.body.connectionId;
}

async function connectGitLab(member: Member, host: string) {
  return await manualGrant(member, "gitlab", {
    accessToken: `glpat-${randomUUID()}`,
    host,
  });
}

async function listGitLabAccounts(member: Member) {
  const response = await accept(
    accounts().connections({
      headers: as(member),
      query: { kind: "builtin", connectorSlug: "gitlab", limit: 100 },
    }),
    [200],
  );
  return response.body;
}

describe("GET /api/connectors", () => {
  it("connectors-list-001 returns an empty list for a member without accounts", async () => {
    const body = await listConnectors(newMember());

    expect(body.connectors).toStrictEqual([]);
  });

  it("connectors-list-002 lists a GitLab account connected through a manual grant", async () => {
    const member = newMember();
    const connectionId = await connectGitLab(member, "gitlab.example.com");

    const body = await listConnectors(member);

    expect(body.connectors).toStrictEqual([
      expect.objectContaining({
        id: connectionId,
        slug: "gitlab",
        authMethod: "api-token",
        connectionStatus: "connected",
      }),
    ]);
  });

  it("connectors-list-003 lists both HTTP and MCP connector accounts", async () => {
    const member = newMember();
    await connectGitLab(member, "gitlab.example.com");
    await manualGrant(member, "manual-mcp", { apiKey: `mcp-${randomUUID()}` });

    const body = await listConnectors(member);

    expect(
      body.connectors.map((connector) => {
        return connector.slug;
      }),
    ).toStrictEqual(expect.arrayContaining(["gitlab", "manual-mcp"]));
  });

  it("connectors-list-004 projects the chosen default account until every account is disconnected", async () => {
    const member = newMember();
    const first = await connectGitLab(member, "gitlab.first.example.com");
    const second = await connectGitLab(member, "gitlab.second.example.com");
    expect(first).not.toBe(second);

    await accept(
      accounts().setDefault({
        headers: as(member),
        params: { connectionId: second },
        body: { target: GITLAB },
      }),
      [200],
    );
    const accountList = await listGitLabAccounts(member);
    const listed = await listConnectors(member);
    const defaultRead = await accept(
      accounts().connection({
        headers: as(member),
        params: { connectionId: second },
        query: GITLAB,
      }),
      [200],
    );

    expect(
      accountList.connections.map((connection) => {
        return [connection.id, connection.isDefault];
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        [first, false],
        [second, true],
      ]),
    );
    expect(accountList.connections).toHaveLength(2);
    expect(accountList.defaultConnection?.id).toBe(second);
    expect(listed.connectors).toStrictEqual([
      expect.objectContaining({
        id: second,
        slug: "gitlab",
        connectionStatus: "connected",
      }),
    ]);
    expect(defaultRead.body).toMatchObject({ id: second, isDefault: true });

    for (const connectionId of [first, second]) {
      await accept(
        accounts().delete({
          headers: as(member),
          params: { connectionId },
          body: { target: GITLAB },
        }),
        [200],
      );
    }

    const emptied = await listConnectors(member);
    const remainingAccounts = await listGitLabAccounts(member);

    expect(emptied).toStrictEqual({ connectors: [] });
    expect(remainingAccounts.defaultConnection).toBeNull();
  });
});
