import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const OPENAI = { kind: "builtin", connectorSlug: "openai" } as const;

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function member(orgId = `org_${randomUUID()}`): Member {
  return { userId: `user_${randomUUID()}`, orgId };
}

function signIn(
  actor: Member,
  role: "org:admin" | "org:member" = "org:member",
): void {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId, role);
}

function accessApi() {
  return setupApp({ context, routes: chatConnectorAccessRoutes })(
    chatConnectorAccessContract,
  );
}

function accountsApi() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

/** Requests run as whichever member signed in last. */
async function createChat(): Promise<string> {
  const thread = await accept(
    setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    ).create({ headers, body: { model: null } }),
    [201],
  );
  return thread.body.id;
}

/** Requests run as whichever member signed in last. */
async function addOpenAiAccount(displayName: string): Promise<string> {
  const connected = await accept(
    setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    ).connect({
      headers,
      params: { connectorSlug: "openai" },
      body: {
        authMethod: "api-token",
        values: { apiKey: `sk-test-${randomUUID()}` },
        account: { intent: "add", displayName },
      },
    }),
    [200],
  );
  return connected.body.connectionId;
}

describe("Chat connector account configuration", () => {
  it("chat-connector-access-005 rejects foreign accounts, Chats and mismatched targets", async () => {
    const owner = member();
    signIn(owner);
    const [ownChat, ownAccount] = await Promise.all([
      createChat(),
      addOpenAiAccount("Work"),
    ]);
    signIn(member(owner.orgId));
    const [colleagueChat, colleagueAccount] = await Promise.all([
      createChat(),
      addOpenAiAccount("Colleague"),
    ]);
    signIn({ userId: owner.userId, orgId: `org_${randomUUID()}` });
    const otherOrgAccount = await addOpenAiAccount("Elsewhere");

    signIn(owner);
    const foreign = [colleagueAccount, otherOrgAccount, randomUUID()];
    const [own, ...rejected] = await Promise.all([
      accept(
        accountsApi().connection({
          headers,
          params: { connectionId: ownAccount },
          query: OPENAI,
        }),
        [200],
      ),
      ...foreign.flatMap((connectionId) => {
        return [
          accept(
            accessApi().updateAccountDefault({
              headers,
              params: { connectionId },
              body: { target: OPENAI, enabled: true },
            }),
            [404],
          ),
          accept(
            accessApi().setThreadOverride({
              headers,
              params: { threadId: ownChat, connectionId },
              body: { target: OPENAI, enabled: true },
            }),
            [404],
          ),
        ];
      }),
      accept(
        accessApi().updateAccountDefault({
          headers,
          params: { connectionId: ownAccount },
          body: {
            target: { kind: "builtin", connectorSlug: "slack" },
            enabled: true,
          },
        }),
        [404],
      ),
      accept(
        accessApi().getThread({
          headers,
          params: { threadId: colleagueChat },
          query: OPENAI,
        }),
        [404],
      ),
    ]);
    expect(own.body.id).toBe(ownAccount);
    expect(
      rejected.map((response) => {
        return response.status;
      }),
    ).toStrictEqual(
      Array.from({ length: 8 }, () => {
        return 404;
      }),
    );

    const ownAccess = await accept(
      accessApi().getThread({
        headers,
        params: { threadId: ownChat },
        query: OPENAI,
      }),
      [200],
    );
    expect(ownAccess.body.currentConnectionId).toBe(ownAccount);
  });
});
