import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthDeviceAuthSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsOauthDeviceAuthRoutes } from "../connectors-oauth-device-auth";
import { featureSwitchesRoutes } from "../feature-switches";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockTestOAuthDeviceConnectorProvider } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const slug = "test-oauth-device" as const;

const deviceAuth = setupApp({
  context,
  routes: builtinConnectorsOauthDeviceAuthRoutes,
})(builtinConnectorOauthDeviceAuthSessionContract);
const accountClient = setupApp({
  context,
  routes: connectorAccountRoutes,
})(connectorAccountsContract);
const featureSwitchClient = setupApp({
  context,
  routes: featureSwitchesRoutes,
})(featureSwitchesContract);

type DeviceProvider = ReturnType<typeof mockTestOAuthDeviceConnectorProvider>;

interface DeviceSession {
  readonly sessionId: string;
  readonly sessionToken: string;
}

function auth(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" } as const;
}

async function deviceOwner() {
  const owner = bdd.user();
  await accept(
    featureSwitchClient.update({
      headers: auth(owner),
      body: { switches: { [FeatureSwitchKey.TestOauthConnector]: true } },
    }),
    [200],
  );
  return owner;
}

function reconnect(connectionId: string) {
  return { intent: "reconnect" as const, connectionId };
}

async function start(actor: ApiTestUser, connectionId?: string) {
  const response = await accept(
    deviceAuth.create({
      headers: auth(actor),
      params: { connectorSlug: slug },
      body: {
        authMethod: "oauth",
        account: connectionId ? reconnect(connectionId) : { intent: "add" },
      },
    }),
    [200],
  );
  return response.body;
}

async function startExpect404(actor: ApiTestUser, connectionId: string) {
  return await accept(
    deviceAuth.create({
      headers: auth(actor),
      params: { connectorSlug: slug },
      body: {
        authMethod: "oauth",
        account: reconnect(connectionId),
      },
    }),
    [404],
  );
}

async function poll(actor: ApiTestUser, session: DeviceSession) {
  return await accept(
    deviceAuth.poll({
      headers: auth(actor),
      params: { connectorSlug: slug, sessionId: session.sessionId },
      body: { sessionToken: session.sessionToken },
    }),
    [200],
  );
}

async function pollComplete(actor: ApiTestUser, session: DeviceSession) {
  const response = await poll(actor, session);
  if (!("status" in response.body) || response.body.status !== "complete") {
    throw new Error(
      `Expected a completed session: ${JSON.stringify(response.body)}`,
    );
  }
  expect(Object.keys(response.body).sort()).toStrictEqual([
    "connectionId",
    "status",
  ]);
  return response.body.connectionId;
}

async function connect(
  actor: ApiTestUser,
  provider: DeviceProvider,
  subject: string,
) {
  provider.setSubject(subject);
  const session = await start(actor);
  return { session, connectionId: await pollComplete(actor, session) };
}

async function roles(actor: ApiTestUser) {
  const response = await accept(
    accountClient.connections({
      headers: auth(actor),
      query: { kind: "builtin", connectorSlug: slug, limit: 100 },
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

/** Two workspaces: the first owner awaits a reconnect, the other a pending add. */
async function ownersWithWaitingSessions(provider: DeviceProvider) {
  const owner = await deviceOwner();
  const other = await deviceOwner();
  const primary = await connect(owner, provider, "subject-a");
  const secondary = await connect(owner, provider, "subject-b");
  const superseded = await start(owner, secondary.connectionId);
  const foreignSession = await start(other);
  return { owner, other, primary, secondary, superseded, foreignSession };
}

/** Two connected accounts, a deleted third and a waiting reconnect to the survivor. */
async function ownerWithDeletedAccount(provider: DeviceProvider) {
  const owner = await deviceOwner();
  const first = await connect(owner, provider, "subject-a");
  const second = await connect(owner, provider, "subject-b");
  const deleted = await connect(owner, provider, "subject-c");
  const [, waiting] = await Promise.all([
    accept(
      accountClient.delete({
        headers: auth(owner),
        params: { connectionId: deleted.connectionId },
        body: { target: { kind: "builtin", connectorSlug: slug } },
      }),
      [200],
    ),
    start(owner, second.connectionId),
  ]);
  return { owner, first, second, deleted, waiting };
}

describe("Builtin device-auth session creation", () => {
  it("connector-device-auth-session-creation-001 (1/4) supersedes the waiting reconnect with a distinct replacement", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider();
    const { owner, secondary, superseded } =
      await ownersWithWaitingSessions(provider);

    const replacement = await start(owner, secondary.connectionId);
    expect(replacement.sessionId).not.toBe(superseded.sessionId);
    expect(replacement.sessionToken).not.toBe(superseded.sessionToken);

    const old = await poll(owner, superseded);
    expect(old.body).toStrictEqual({
      status: "error",
      errorCode: "session_superseded",
      errorMessage: "OAuth device authorization session was superseded",
    });
  });

  it("connector-device-auth-session-creation-001 (2/4) replays the completed default after superseding the sibling", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider();
    const { owner, primary, secondary } =
      await ownersWithWaitingSessions(provider);
    await start(owner, secondary.connectionId);

    await expect(pollComplete(owner, primary.session)).resolves.toBe(
      primary.connectionId,
    );
  });

  it("connector-device-auth-session-creation-001 (3/4) completes the foreign session for its owner and hides it from the first owner", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider();
    const { owner, other, secondary, foreignSession } =
      await ownersWithWaitingSessions(provider);
    await start(owner, secondary.connectionId);

    provider.setSubject("subject-foreign");
    const foreignId = await pollComplete(other, foreignSession);
    const foreignReconnect = await startExpect404(owner, foreignId);

    expect(foreignReconnect.body.error.message).toBe(
      "Connector account not found",
    );
    await expect(roles(other)).resolves.toStrictEqual([
      { id: foreignId, isDefault: true },
    ]);
  });

  it("connector-device-auth-session-creation-001 (4/4) completes the replacement for the exact non-default account", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider();
    const { owner, primary, secondary } =
      await ownersWithWaitingSessions(provider);
    const replacement = await start(owner, secondary.connectionId);

    provider.setSubject("subject-b");
    await expect(pollComplete(owner, replacement)).resolves.toBe(
      secondary.connectionId,
    );
    await expect(roles(owner)).resolves.toStrictEqual(
      sorted([
        { id: primary.connectionId, isDefault: true },
        { id: secondary.connectionId, isDefault: false },
      ]),
    );
  });

  it("connector-device-auth-session-creation-002 (1/2) rejects reconnect to the deleted account", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider();
    const { owner, deleted } = await ownerWithDeletedAccount(provider);

    const rejected = await startExpect404(owner, deleted.connectionId);

    expect(rejected.body.error).toMatchObject({
      code: "NOT_FOUND",
      message: "Connector account not found",
    });
  });

  it("connector-device-auth-session-creation-002 (2/2) still completes the waiting survivor reconnect", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider();
    const { owner, first, second, deleted, waiting } =
      await ownerWithDeletedAccount(provider);
    await startExpect404(owner, deleted.connectionId);

    provider.setSubject("subject-b");
    await expect(pollComplete(owner, waiting)).resolves.toBe(
      second.connectionId,
    );
    await expect(roles(owner)).resolves.toStrictEqual(
      sorted([
        { id: first.connectionId, isDefault: true },
        { id: second.connectionId, isDefault: false },
      ]),
    );
  });
});
