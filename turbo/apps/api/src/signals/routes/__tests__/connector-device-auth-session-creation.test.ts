import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthDeviceAuthSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsOauthDeviceAuthRoutes } from "../connectors-oauth-device-auth";
import { featureSwitchesRoutes } from "../feature-switches";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockTestOAuthDeviceConnectorProvider } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const slug = "test-oauth-device" as const;
const DEVICE_TOKEN_URL = "http://localhost:3000/api/test/oauth-provider/token";

const REJECTED_DEVICE_RECONNECT = Object.freeze({
  status: "error",
  errorCode: "connector_account_rejected",
  errorMessage: "Connector account not found",
});

const EXPIRED_DEVICE_SESSION = Object.freeze({
  status: "expired",
  errorCode: "expired_token",
  errorMessage: "OAuth device authorization session expired",
});

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

  it("connector-device-auth-claim-awaiting-001 (1/3) keeps the provider interval and then the slowed interval between due polls", async () => {
    const scenario = await startAwaitingSiblingReconnect();

    for (const offsetMs of [2000, 3999]) {
      const pending = await scenario.pollAt(offsetMs);
      expect(pending.status).toBe(200);
      expect(pending.body).toStrictEqual({ status: "pending", interval: 2 });
    }
    for (const offsetMs of [4000, 10_999]) {
      const slowed = await scenario.pollAt(offsetMs);
      expect(slowed.status).toBe(200);
      expect(slowed.body).toStrictEqual({ status: "pending", interval: 7 });
    }
  });

  it("connector-device-auth-claim-awaiting-001 (2/3) fails the malformed provider success without changing accounts and keeps the slowed interval", async () => {
    const scenario = await startAwaitingSiblingReconnect();
    await pollThroughOffsets(scenario, [2000, 4000]);

    const failed = await scenario.pollAt(11_000);
    expect(failed.status).toBe(500);
    expect(failed.body).toStrictEqual({ error: "Internal server error" });
    await expect(rolesWithExternalId(scenario.owner)).resolves.toStrictEqual(
      scenario.rolesBefore,
    );

    const stillPending = await scenario.pollAt(17_999);
    expect(stillPending.status).toBe(200);
    expect(stillPending.body).toStrictEqual({ status: "pending", interval: 7 });
  });

  it("connector-device-auth-claim-awaiting-001 (3/3) completes and replays the same non-default account without credentials", async () => {
    const scenario = await startAwaitingSiblingReconnect();
    await pollThroughOffsets(scenario, [2000, 4000, 11_000]);

    const completed = await scenario.pollAt(18_000);
    expect(completed.status).toBe(200);
    expect(completed.body).toStrictEqual({
      status: "complete",
      connectionId: scenario.siblingId,
    });
    const replay = await scenario.pollAt(18_000);
    expect(replay.status).toBe(200);
    expect(replay.body).toStrictEqual(completed.body);

    const exposed = JSON.stringify([completed.body, replay.body]);
    expect(exposed).not.toContain("device-sibling-access-token");
    expect(exposed).not.toContain(scenario.sessionToken);
    const readback = await accept(
      accountClient.connection({
        headers: auth(scenario.owner),
        params: { connectionId: scenario.siblingId },
        query: { kind: "builtin", connectorSlug: slug },
      }),
      [200],
    );
    expect(readback.body).toMatchObject({
      externalId: "device-sibling-user",
      isDefault: false,
    });
  });

  it("connector-device-auth-claim-terminal-005 (1/2) rejects the reconnect of a deleted account on every poll and keeps the default", async () => {
    const { owner, defaultId, reconnectSession } =
      await reconnectDeletedSibling();

    await expect(poll(owner, reconnectSession)).resolves.toMatchObject({
      body: REJECTED_DEVICE_RECONNECT,
    });
    await expect(poll(owner, reconnectSession)).resolves.toMatchObject({
      body: REJECTED_DEVICE_RECONNECT,
    });
    await expect(roles(owner)).resolves.toStrictEqual([
      { id: defaultId, isDefault: true },
    ]);
  });

  it("connector-device-auth-claim-terminal-005 (2/2) adds a distinct account and still replays the rejected reconnect", async () => {
    const { owner, defaultId, siblingId, reconnectSession } =
      await reconnectDeletedSibling();
    await poll(owner, reconnectSession);

    const provider = mockTestOAuthDeviceConnectorProvider();
    const added = await connect(owner, provider, "device-added-user");
    expect(added.connectionId).not.toBe(defaultId);
    expect(added.connectionId).not.toBe(siblingId);
    await expect(poll(owner, reconnectSession)).resolves.toMatchObject({
      body: REJECTED_DEVICE_RECONNECT,
    });
    await expect(roles(owner)).resolves.toStrictEqual(
      sorted([
        { id: defaultId, isDefault: true },
        { id: added.connectionId, isDefault: false },
      ]),
    );
  });

  it("connector-device-auth-session-expiration-001 (1/2) keeps the reconnect pending at its deadline and expires it one millisecond later", async () => {
    const { owner, expectedRoles, startTime, reconnectSession } =
      await pendingExpiringSiblingReconnect();

    mockNow(startTime + 60_000);
    await expect(poll(owner, reconnectSession)).resolves.toMatchObject({
      body: { status: "pending", interval: 0 },
    });
    mockNow(startTime + 60_001);
    await expect(poll(owner, reconnectSession)).resolves.toMatchObject({
      body: EXPIRED_DEVICE_SESSION,
    });
    await expect(roles(owner)).resolves.toStrictEqual(expectedRoles);
  });

  it("connector-device-auth-session-expiration-001 (2/2) stays expired after the provider recovers and a new reconnect completes the same account", async () => {
    const { owner, siblingId, expectedRoles, startTime, reconnectSession } =
      await pendingExpiringSiblingReconnect();
    mockNow(startTime + 60_001);
    await poll(owner, reconnectSession);

    const provider = mockTestOAuthDeviceConnectorProvider();
    provider.setSubject("device-sibling-user");
    await expect(poll(owner, reconnectSession)).resolves.toMatchObject({
      body: EXPIRED_DEVICE_SESSION,
    });
    const recovery = await start(owner, siblingId);
    await expect(pollComplete(owner, recovery)).resolves.toBe(siblingId);
    await expect(poll(owner, reconnectSession)).resolves.toMatchObject({
      body: EXPIRED_DEVICE_SESSION,
    });
    await expect(roles(owner)).resolves.toStrictEqual(expectedRoles);
  });
});

function mockDeviceTokenSequence(responses: readonly (() => Response)[]): void {
  let calls = 0;
  server.use(
    http.post(DEVICE_TOKEN_URL, () => {
      const respond = responses[calls];
      calls += 1;
      if (!respond) {
        throw new Error("Unexpected extra device token poll");
      }
      return respond();
    }),
  );
}

async function rolesWithExternalId(actor: ApiTestUser) {
  const response = await accept(
    accountClient.connections({
      headers: auth(actor),
      query: { kind: "builtin", connectorSlug: slug, limit: 100 },
    }),
    [200],
  );
  return response.body.connections
    .map((account) => {
      return {
        id: account.id,
        externalId: account.externalId,
        isDefault: account.isDefault,
      };
    })
    .sort((left, right) => {
      return left.id.localeCompare(right.id);
    });
}

async function startAwaitingSiblingReconnect() {
  const provider = mockTestOAuthDeviceConnectorProvider();
  const owner = await deviceOwner();
  const first = await connect(owner, provider, "device-default-user");
  const sibling = await connect(owner, provider, "device-sibling-user");
  const rolesBefore = [
    {
      id: first.connectionId,
      externalId: "device-default-user",
      isDefault: true,
    },
    {
      id: sibling.connectionId,
      externalId: "device-sibling-user",
      isDefault: false,
    },
  ].sort((left, right) => {
    return left.id.localeCompare(right.id);
  });

  const startTime = now();
  mockNow(startTime);
  mockTestOAuthDeviceConnectorProvider({ interval: 2 });
  mockDeviceTokenSequence([
    () => {
      return HttpResponse.json(
        { error: "authorization_pending" },
        { status: 400 },
      );
    },
    () => {
      return HttpResponse.json({ error: "slow_down" }, { status: 400 });
    },
    () => {
      return HttpResponse.json({ token_type: "Bearer" });
    },
    () => {
      return HttpResponse.json({
        access_token: "device-sibling-access-token",
        sub: "device-sibling-user",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      });
    },
  ]);
  const session = await start(owner, sibling.connectionId);
  return {
    owner,
    siblingId: sibling.connectionId,
    rolesBefore,
    sessionToken: session.sessionToken,
    async pollAt(offsetMs: number) {
      mockNow(startTime + offsetMs);
      return await accept(
        deviceAuth.poll({
          headers: auth(owner),
          params: { connectorSlug: slug, sessionId: session.sessionId },
          body: { sessionToken: session.sessionToken },
        }),
        [200, 500],
      );
    },
  };
}

async function pollThroughOffsets(
  scenario: Awaited<ReturnType<typeof startAwaitingSiblingReconnect>>,
  offsets: readonly number[],
): Promise<void> {
  for (const offsetMs of offsets) {
    await scenario.pollAt(offsetMs);
  }
}

async function reconnectDeletedSibling() {
  const provider = mockTestOAuthDeviceConnectorProvider();
  const owner = await deviceOwner();
  const first = await connect(owner, provider, "device-default-user");
  const sibling = await connect(owner, provider, "device-sibling-user");
  provider.setSubject("device-sibling-user");
  const reconnectSession = await start(owner, sibling.connectionId);
  await accept(
    accountClient.delete({
      headers: auth(owner),
      params: { connectionId: sibling.connectionId },
      body: { target: { kind: "builtin", connectorSlug: slug } },
    }),
    [200],
  );
  return {
    owner,
    defaultId: first.connectionId,
    siblingId: sibling.connectionId,
    reconnectSession,
  };
}

async function pendingExpiringSiblingReconnect() {
  const provider = mockTestOAuthDeviceConnectorProvider();
  const owner = await deviceOwner();
  const first = await connect(owner, provider, "device-default-user");
  const sibling = await connect(owner, provider, "device-sibling-user");
  const expectedRoles = sorted([
    { id: first.connectionId, isDefault: true },
    { id: sibling.connectionId, isDefault: false },
  ]);

  const startTime = now();
  mockNow(startTime);
  mockTestOAuthDeviceConnectorProvider({
    deviceCode: "pending",
    expiresIn: 60,
  });
  const reconnectSession = await start(owner, sibling.connectionId);
  return {
    owner,
    siblingId: sibling.connectionId,
    expectedRoles,
    startTime,
    reconnectSession,
  };
}
