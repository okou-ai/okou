import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorExternalCodeSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsExternalCodeRoutes } from "../connectors-external-code";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);

const externalCode = setupApp({
  context,
  routes: builtinConnectorsExternalCodeRoutes,
})(builtinConnectorExternalCodeSessionContract);
const accountClient = setupApp({
  context,
  routes: connectorAccountRoutes,
})(connectorAccountsContract);

type AwsProvider = ReturnType<typeof mockAwsExternalCodeProvider>;

interface Session {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly authorizationUrl: string;
}

function auth(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" } as const;
}

function reconnect(connectionId: string) {
  return { intent: "reconnect" as const, connectionId };
}

async function start(actor: ApiTestUser, connectionId?: string) {
  const response = await accept(
    externalCode.create({
      headers: auth(actor),
      params: { connectorSlug: "aws" },
      body: {
        authMethod: "cli",
        account: connectionId ? reconnect(connectionId) : { intent: "add" },
      },
    }),
    [200],
  );
  return response.body;
}

async function startExpect404(actor: ApiTestUser, connectionId: string) {
  return await accept(
    externalCode.create({
      headers: auth(actor),
      params: { connectorSlug: "aws" },
      body: {
        authMethod: "cli",
        account: reconnect(connectionId),
      },
    }),
    [404],
  );
}

function complete(actor: ApiTestUser, session: Session) {
  return accept(
    externalCode.complete({
      headers: auth(actor),
      params: { connectorSlug: "aws", sessionId: session.sessionId },
      body: {
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl),
      },
    }),
    [200, 400],
  );
}

async function completed(actor: ApiTestUser, session: Session) {
  const response = await complete(actor, session);
  if (response.status !== 200) {
    throw new Error(`Expected completion: ${JSON.stringify(response.body)}`);
  }
  expect(response.body).toStrictEqual({
    status: "complete",
    connectionId: response.body.connectionId,
  });
  return response.body.connectionId;
}

async function connect(
  actor: ApiTestUser,
  provider: AwsProvider,
  accountId: string,
) {
  provider.setAccountId(accountId);
  const session = await start(actor);
  return { session, connectionId: await completed(actor, session) };
}

async function roles(actor: ApiTestUser) {
  const response = await accept(
    accountClient.connections({
      headers: auth(actor),
      query: { kind: "builtin", connectorSlug: "aws", limit: 100 },
    }),
    [200],
  );
  return sorted(
    response.body.connections.map((account) => {
      return { id: account.id, isDefault: account.isDefault };
    }),
  );
}

function sorted(entries: { id: string; isDefault: boolean }[]) {
  return entries.sort((left, right) => {
    return left.id.localeCompare(right.id);
  });
}

/** Two workspaces: the first owner has a pending sibling reconnect, the other a pending add. */
async function ownersWithPendingSessions(provider: AwsProvider) {
  const owner = bdd.user();
  const other = bdd.user();
  const primary = await connect(owner, provider, "111111111111");
  const secondary = await connect(owner, provider, "222222222222");
  const superseded = await start(owner, secondary.connectionId);
  const foreignSession = await start(other);
  return { owner, other, primary, secondary, superseded, foreignSession };
}

/** The replacement for the sibling reconnect, completed by the first owner. */
async function completeReplacement(
  provider: AwsProvider,
  owner: ApiTestUser,
  secondaryId: string,
) {
  const replacement = await start(owner, secondaryId);
  provider.setAccountId("222222222222");
  const connectionId = await completed(owner, replacement);
  return { replacement, connectionId };
}

describe("Builtin external-code session creation", () => {
  it("connector-external-code-session-creation-001 (1/4) supersedes the pending reconnect with a distinct replacement", async () => {
    const provider = mockAwsExternalCodeProvider();
    const { owner, secondary, superseded } =
      await ownersWithPendingSessions(provider);

    const replacement = await start(owner, secondary.connectionId);
    expect(replacement.sessionId).not.toBe(superseded.sessionId);
    expect(replacement.sessionToken).not.toBe(superseded.sessionToken);

    const old = await complete(owner, superseded);
    expect(old.status).toBe(400);
    expect(old.body).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "External-code authorization session was superseded",
      },
    });
  });

  it("connector-external-code-session-creation-001 (2/4) replays the completed default after superseding the sibling", async () => {
    const provider = mockAwsExternalCodeProvider();
    const { owner, primary, secondary } =
      await ownersWithPendingSessions(provider);
    await start(owner, secondary.connectionId);

    await expect(completed(owner, primary.session)).resolves.toBe(
      primary.connectionId,
    );
  });

  it("connector-external-code-session-creation-001 (3/4) finishes the foreign session for its owner and hides it from the first owner", async () => {
    const provider = mockAwsExternalCodeProvider();
    const { owner, other, secondary, foreignSession } =
      await ownersWithPendingSessions(provider);
    await start(owner, secondary.connectionId);

    provider.setAccountId("444444444444");
    const foreignId = await completed(other, foreignSession);
    const foreignReconnect = await startExpect404(owner, foreignId);

    expect(foreignReconnect.body.error.message).toBe(
      "Connector account not found",
    );
    await expect(roles(other)).resolves.toStrictEqual([
      { id: foreignId, isDefault: true },
    ]);
  });

  it("connector-external-code-session-creation-001 (4/4) completes the replacement for the exact non-default account", async () => {
    const provider = mockAwsExternalCodeProvider();
    const { owner, primary, secondary } =
      await ownersWithPendingSessions(provider);

    const { connectionId } = await completeReplacement(
      provider,
      owner,
      secondary.connectionId,
    );

    expect(connectionId).toBe(secondary.connectionId);
    await expect(roles(owner)).resolves.toStrictEqual(
      sorted([
        { id: primary.connectionId, isDefault: true },
        { id: secondary.connectionId, isDefault: false },
      ]),
    );
  });
});
