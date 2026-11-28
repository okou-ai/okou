import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorExternalCodeSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsExternalCodeRoutes } from "../connectors-external-code";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { countPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const AWS_SIGNIN_TOKEN_URL = "https://us-east-1.signin.aws.amazon.com/v1/token";
const AWS_SECRETS = Object.freeze([
  "aws-secret-access-key",
  "aws-session-token",
  "aws-login-refresh-token",
]);
const EXPIRED_EXTERNAL_CODE = Object.freeze({
  error: {
    message: "External-code authorization session expired",
    code: "BAD_REQUEST",
  },
});

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

  it("connector-external-code-session-creation-002 (1/2) rejects reconnect to the deleted account", async () => {
    const provider = mockAwsExternalCodeProvider();
    const { owner, deleted } = await ownerWithDeletedAccount(provider);

    const rejected = await startExpect404(owner, deleted.connectionId);

    expect(rejected.body.error).toMatchObject({
      code: "NOT_FOUND",
      message: "Connector account not found",
    });
  });

  it("connector-external-code-session-creation-002 (2/2) still completes the pending survivor reconnect", async () => {
    const provider = mockAwsExternalCodeProvider();
    const { owner, first, second, deleted, pending } =
      await ownerWithDeletedAccount(provider);

    provider.setAccountId("222222222222");
    const [, connectionId] = await Promise.all([
      startExpect404(owner, deleted.connectionId),
      completed(owner, pending),
    ]);
    expect(connectionId).toBe(second.connectionId);
    await expect(roles(owner)).resolves.toStrictEqual(
      sorted([
        { id: first.connectionId, isDefault: true },
        { id: second.connectionId, isDefault: false },
      ]),
    );
  });

  it("connector-external-code-claim-completion-001 (1/3) rejects the invalid code without changing account roles", async () => {
    const { owner, expectedRoles, reconnectSession } =
      await siblingReconnectWithTransientFailures();

    const invalid = await completeWithCode(owner, reconnectSession, "AWS-BAD");
    expect(invalid.status).toBe(400);
    expect(invalid.body).toStrictEqual({
      error: {
        message:
          "External-code authorization code was rejected. Check it and try again.",
        code: "BAD_REQUEST",
      },
    });
    const exposed = JSON.stringify(invalid.body);
    for (const secret of [reconnectSession.sessionToken, ...AWS_SECRETS]) {
      expect(exposed).not.toContain(secret);
    }
    await expect(roles(owner)).resolves.toStrictEqual(expectedRoles);
  });

  it("connector-external-code-claim-completion-001 (2/3) fails both transient provider errors without changing account roles", async () => {
    const { owner, expectedRoles, reconnectSession } =
      await siblingReconnectWithTransientFailures();
    await completeWithCode(owner, reconnectSession, "AWS-BAD");

    for (const transient of [
      await completeWithCode(owner, reconnectSession),
      await completeWithCode(owner, reconnectSession),
    ]) {
      expect(transient.status).toBe(500);
      expect(transient.body).toStrictEqual({ error: "Internal server error" });
    }
    await expect(roles(owner)).resolves.toStrictEqual(expectedRoles);
  });

  it("connector-external-code-claim-completion-001 (3/3) recovers into the non-default account and replays it identically", async () => {
    const { owner, siblingId, reconnectSession } =
      await siblingReconnectWithTransientFailures();
    await completeWithCode(owner, reconnectSession, "AWS-BAD");
    await completeWithCode(owner, reconnectSession);
    await completeWithCode(owner, reconnectSession);

    const recovered = await completeWithCode(owner, reconnectSession);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      status: "complete",
      connectionId: siblingId,
    });
    const replay = await completeWithCode(owner, reconnectSession);
    expect(replay.status).toBe(200);
    expect(replay.body).toStrictEqual(recovered.body);

    const exposed = JSON.stringify([recovered.body, replay.body]);
    for (const secret of [reconnectSession.sessionToken, ...AWS_SECRETS]) {
      expect(exposed).not.toContain(secret);
    }
  });

  it("connector-external-code-session-claim-001 (1/2) rejects the first code and keeps both default flags", async () => {
    const { owner, defaultId, siblingId, reconnectSession } =
      await siblingReconnectPair();

    const rejected = await completeWithCode(owner, reconnectSession, "AWS-BAD");
    expect(rejected.status).toBe(400);
    expect(rejected.body).toStrictEqual({
      error: {
        message:
          "External-code authorization code was rejected. Check it and try again.",
        code: "BAD_REQUEST",
      },
    });
    const exposed = JSON.stringify(rejected.body);
    for (const secret of [reconnectSession.sessionToken, ...AWS_SECRETS]) {
      expect(exposed).not.toContain(secret);
    }
    await expect(roles(owner)).resolves.toStrictEqual(
      sorted([
        { id: defaultId, isDefault: true },
        { id: siblingId, isDefault: false },
      ]),
    );
  });

  it("connector-external-code-session-claim-001 (2/2) completes the retry into the non-default account, notifies the owner and replays it", async () => {
    const { owner, defaultId, siblingId, reconnectSession } =
      await siblingReconnectPair();
    await completeWithCode(owner, reconnectSession, "AWS-BAD");
    const changeEvents = () => {
      return countPublishedTo(context.mocks, {
        channel: `user:${owner.userId}`,
        topic: "connector:changed",
      });
    };
    const eventsBefore = changeEvents();

    const recovered = await completeWithCode(owner, reconnectSession);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toStrictEqual({
      status: "complete",
      connectionId: siblingId,
    });
    expect(changeEvents()).toBe(eventsBefore + 1);
    const replay = await completeWithCode(owner, reconnectSession);
    expect(replay.status).toBe(200);
    expect(replay.body).toStrictEqual(recovered.body);
    const exposed = JSON.stringify([recovered.body, replay.body]);
    for (const secret of [reconnectSession.sessionToken, ...AWS_SECRETS]) {
      expect(exposed).not.toContain(secret);
    }

    const listed = await accept(
      accountClient.connections({
        headers: auth(owner),
        query: { kind: "builtin", connectorSlug: "aws", limit: 100 },
      }),
      [200],
    );
    expect(
      listed.body.connections
        .map((account) => {
          return {
            id: account.id,
            authMethod: account.authMethod,
            connectionStatus: account.connectionStatus,
            externalId: account.externalId,
            isDefault: account.isDefault,
          };
        })
        .sort((left, right) => {
          return Number(right.isDefault) - Number(left.isDefault);
        }),
    ).toStrictEqual([
      {
        id: defaultId,
        authMethod: "cli",
        connectionStatus: "connected",
        externalId: "111111111111",
        isDefault: true,
      },
      {
        id: siblingId,
        authMethod: "cli",
        connectionStatus: "connected",
        externalId: "222222222222",
        isDefault: false,
      },
    ]);
  });

  it("connector-external-code-session-expiration-001 (1/3) rejects the bad code at the exact deadline and expires the session one millisecond later", async () => {
    const { owner, expectedRoles, reconnectSession, deadline } =
      await expiringSiblingReconnect();

    mockNow(deadline);
    const rejected = await completeWithCode(owner, reconnectSession, "AWS-BAD");
    expect(rejected.status).toBe(400);
    expect(rejected.body).toStrictEqual({
      error: {
        message:
          "External-code authorization code was rejected. Check it and try again.",
        code: "BAD_REQUEST",
      },
    });

    mockNow(deadline + 1);
    const expired = await completeWithCode(owner, reconnectSession);
    expect(expired.status).toBe(400);
    expect(expired.body).toStrictEqual(EXPIRED_EXTERNAL_CODE);
    await expect(roles(owner)).resolves.toStrictEqual(expectedRoles);
  });

  it("connector-external-code-session-expiration-001 (2/3) stays expired while a fresh reconnect completes the same account", async () => {
    const { owner, siblingId, expectedRoles, reconnectSession, deadline } =
      await expiringSiblingReconnect();
    mockNow(deadline + 1);
    await completeWithCode(owner, reconnectSession);

    const recovery = await start(owner, siblingId);
    const recovered = await completeWithCode(owner, recovery);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toStrictEqual({
      status: "complete",
      connectionId: siblingId,
    });
    const expired = await completeWithCode(owner, reconnectSession);
    expect(expired.status).toBe(400);
    expect(expired.body).toStrictEqual(EXPIRED_EXTERNAL_CODE);
    const exposed = JSON.stringify([recovered.body, expired.body]);
    for (const secret of [
      reconnectSession.sessionToken,
      recovery.sessionToken,
      ...AWS_SECRETS,
    ]) {
      expect(exposed).not.toContain(secret);
    }
    await expect(roles(owner)).resolves.toStrictEqual(expectedRoles);
  });

  it("connector-external-code-session-expiration-001 (3/3) replays the recovered reconnect even after its own expiry window passes", async () => {
    const { owner, siblingId, reconnectSession, deadline } =
      await expiringSiblingReconnect();
    mockNow(deadline + 1);
    await completeWithCode(owner, reconnectSession);

    const recoveryStart = now();
    const recovery = await start(owner, siblingId);
    const recovered = await completeWithCode(owner, recovery);
    expect(recovered.status).toBe(200);

    mockNow(recoveryStart + recovery.expiresIn * 1000 + 1);
    const replay = await completeWithCode(owner, recovery);
    expect(replay.status).toBe(200);
    expect(replay.body).toStrictEqual(recovered.body);
    const exposed = JSON.stringify(replay.body);
    for (const secret of [recovery.sessionToken, ...AWS_SECRETS]) {
      expect(exposed).not.toContain(secret);
    }
  });
});

function completeWithCode(
  actor: ApiTestUser,
  session: Session,
  code = "AWS-CODE",
) {
  return accept(
    externalCode.complete({
      headers: auth(actor),
      params: { connectorSlug: "aws", sessionId: session.sessionId },
      body: {
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl, code),
      },
    }),
    [200, 400, 500],
  );
}

/** Two AWS accounts, a deleted third and a pending reconnect to the survivor. */
async function ownerWithDeletedAccount(provider: AwsProvider) {
  const owner = bdd.user();
  const first = await connect(owner, provider, "111111111111");
  const second = await connect(owner, provider, "222222222222");
  const deleted = await connect(owner, provider, "333333333333");
  const [, pending] = await Promise.all([
    accept(
      accountClient.delete({
        headers: auth(owner),
        params: { connectionId: deleted.connectionId },
        body: { target: { kind: "builtin", connectorSlug: "aws" } },
      }),
      [200],
    ),
    start(owner, second.connectionId),
  ]);
  return { owner, first, second, deleted, pending };
}

function mockTransientAwsTokenFailures(): void {
  let calls = 0;
  server.use(
    http.post(AWS_SIGNIN_TOKEN_URL, () => {
      calls += 1;
      if (calls === 2) {
        return HttpResponse.json(
          { error: "too_many_requests" },
          { status: 429 },
        );
      }
      if (calls === 3) {
        return HttpResponse.text("Service unavailable", { status: 503 });
      }
      return undefined;
    }),
  );
}

async function siblingReconnectWithTransientFailures() {
  const owner = bdd.user();
  const provider = mockAwsExternalCodeProvider();
  const first = await connect(owner, provider, "111111111111");
  const sibling = await connect(owner, provider, "222222222222");
  const expectedRoles = sorted([
    { id: first.connectionId, isDefault: true },
    { id: sibling.connectionId, isDefault: false },
  ]);
  const reconnectSession = await start(owner, sibling.connectionId);
  mockTransientAwsTokenFailures();
  return {
    owner,
    siblingId: sibling.connectionId,
    expectedRoles,
    reconnectSession,
  };
}

async function siblingReconnectPair() {
  const owner = bdd.user();
  const provider = mockAwsExternalCodeProvider();
  const first = await connect(owner, provider, "111111111111");
  const sibling = await connect(owner, provider, "222222222222");
  const reconnectSession = await start(owner, sibling.connectionId);
  return {
    owner,
    defaultId: first.connectionId,
    siblingId: sibling.connectionId,
    reconnectSession,
  };
}

async function expiringSiblingReconnect() {
  const owner = bdd.user();
  const provider = mockAwsExternalCodeProvider();
  const first = await connect(owner, provider, "111111111111");
  const sibling = await connect(owner, provider, "222222222222");
  const expectedRoles = sorted([
    { id: first.connectionId, isDefault: true },
    { id: sibling.connectionId, isDefault: false },
  ]);
  const startTime = now();
  mockNow(startTime);
  const reconnectSession = await start(owner, sibling.connectionId);
  const deadline = startTime + reconnectSession.expiresIn * 1000;
  return {
    owner,
    siblingId: sibling.connectionId,
    expectedRoles,
    reconnectSession,
    deadline,
  };
}
