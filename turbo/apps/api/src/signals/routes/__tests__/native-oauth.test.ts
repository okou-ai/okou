import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { array, number, object, record, string } from "zod";
import {
  chatThreadMarkReadContract,
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { chatThreadRoutes } from "../chat-threads";
import { projectRoutes } from "../projects";
import { realtimeTokenRoutes } from "../realtime-token";
import { voiceIoQuotaRoutes } from "../voice-io-quota";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const projects = setupApp({ context, routes: projectRoutes })(projectsContract);
const threads = setupApp({ context, routes: chatThreadRoutes })(
  chatThreadsContract,
);
const threadMetadata = setupApp({ context, routes: chatThreadRoutes })(
  chatThreadMetadataContract,
);
const threadReads = setupApp({ context, routes: chatThreadRoutes })(
  chatThreadMarkReadContract,
);
const realtime = setupApp({ context, routes: realtimeTokenRoutes })(
  platformRealtimeTokenContract,
);
// The quota contract does not declare the 403 a missing grant returns.
const voiceQuota = setupRawAppRequest({ context, routes: voiceIoQuotaRoutes });

const ISSUER = "https://clerk.mcp.example.test";
const RESOURCE = "https://api.mcp.example.test/mcp";
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });

const issuerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const issuerKeyId = randomUUID();

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

async function seedMember(identity: Member): Promise<Member> {
  await store.set(
    seedOrgMembership$,
    { ...identity, role: "member" },
    context.signal,
  );
  return identity;
}

/** Configures the OAuth resource and publishes the issuer's signing key. */
function configureOAuthIssuer(): void {
  mockEnv("MCP_RESOURCE_URL", RESOURCE);
  mockEnv("MCP_OAUTH_ISSUER", ISSUER);
  server.use(
    http.get("https://api.clerk.com/v1/jwks", () => {
      return HttpResponse.json({
        keys: [
          {
            ...issuerKeys.publicKey.export({ format: "jwk" }),
            kid: issuerKeyId,
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    }),
  );
}

/**
 * A signed-in member of a fresh workspace whose native client can present
 * OAuth access tokens from the configured issuer.
 */
async function member(): Promise<Member> {
  configureOAuthIssuer();
  const identity = await seedMember({
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  });
  mocks.clerk.session(identity.userId, identity.orgId, "org:member");
  return identity;
}

/** Client-issued Project operation identity (UUIDv7 stamped now). */
function projectOperationId(): string {
  return createProjectOperationId(now(), randomUUID());
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function oauthHeaders(
  identity: Member,
  scope: string,
  expiresInSeconds = 3600,
): { readonly authorization: string } {
  const seconds = Math.floor(now() / 1000);
  const input = `${encode({
    alg: "RS256",
    kid: issuerKeyId,
    typ: "at+jwt",
  })}.${encode({
    iss: ISSUER,
    aud: RESOURCE,
    sub: identity.userId,
    org_id: identity.orgId,
    client_id: "native_test_client",
    scope,
    iat: seconds,
    nbf: seconds - 1,
    exp: seconds + expiresInSeconds,
  })}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(input),
    issuerKeys.privateKey,
  ).toString("base64url");
  return { authorization: `Bearer ${input}.${signature}` };
}

async function createProjectAs(identity: Member, name: string) {
  mocks.clerk.session(identity.userId, identity.orgId, "org:member");
  const id = projectOperationId();
  const response = await accept(
    projects.create({
      headers: SESSION,
      body: { id, eventId: id, name },
    }),
    [201],
  );
  return response.body;
}

async function createThreadAs(identity: Member) {
  mocks.clerk.session(identity.userId, identity.orgId, "org:member");
  const response = await accept(
    threads.create({
      headers: SESSION,
      body: { clientThreadId: randomUUID(), title: "Owned thread" },
    }),
    [201],
  );
  return response.body;
}

const ablyTokenParamsSchema = object({
  capability: record(string(), array(string())),
  timestamp: number().optional(),
  ttl: number().optional(),
  clientId: string().optional(),
});

/** Signs token requests the way the Ably SDK shapes them. */
function signAblyTokenRequests(): void {
  context.mocks.ably.createTokenRequest.mockImplementation(
    (params: unknown) => {
      const tokenParams = ablyTokenParamsSchema.parse(params);
      return Promise.resolve({
        keyName: "app.key",
        timestamp: tokenParams.timestamp ?? now(),
        ttl: tokenParams.ttl,
        capability: JSON.stringify(tokenParams.capability),
        clientId: tokenParams.clientId,
        nonce: "signed-nonce",
        mac: "signed-mac",
      });
    },
  );
}

describe("native organization OAuth grants", () => {
  it("native-oauth-004 rejects a realtime token without the chat read grant", async () => {
    const identity = await member();

    const response = await realtime.create({
      headers: oauthHeaders(identity, "user:org:read okou:chat:send"),
      body: {},
    });

    expect(response.status).toBe(401);
  });

  it("native-oauth-005 rejects the project list without the project read grant", async () => {
    const identity = await member();

    const response = await projects.list({
      headers: oauthHeaders(identity, "user:org:read okou:chat:read"),
    });

    expect(response.status).toBe(403);
  });

  it("native-oauth-006 rejects the voice quota without its grant", async () => {
    const identity = await member();

    const response = await voiceQuota("/api/voice-io/quota", {
      headers: oauthHeaders(identity, "user:org:read okou:chat:read"),
    });

    expect(response.status).toBe(403);
  });

  it("native-oauth-007 rejects thread metadata without the chat read grant", async () => {
    const identity = await member();

    const response = await threadMetadata.get({
      headers: oauthHeaders(identity, "user:org:read okou:chat:send"),
      params: { id: randomUUID() },
    });

    expect(response.status).toBe(403);
  });

  it("native-oauth-001 reads only the grant owner's projects and cannot mutate them", async () => {
    const identity = await member();
    const otherWorkspace = await seedMember({
      userId: identity.userId,
      orgId: `org_${randomUUID()}`,
    });
    const teammate = await seedMember({
      userId: `user_${randomUUID()}`,
      orgId: identity.orgId,
    });
    const owned = await createProjectAs(identity, "Owned project");
    const elsewhere = await createProjectAs(otherWorkspace, "Elsewhere");
    const teammates = await createProjectAs(teammate, "Teammate project");
    const headers = oauthHeaders(identity, "okou:project:read");
    const deniedId = projectOperationId();

    const [
      list,
      snapshot,
      events,
      ownedProject,
      ownedThreads,
      elsewhereProject,
      elsewhereThreads,
      teammateProject,
      teammateThreads,
      created,
      updated,
      deleted,
    ] = await Promise.all([
      projects.list({ headers }),
      projects.snapshot({ headers }),
      projects.events({ headers, query: {} }),
      projects.get({ headers, params: { id: owned.id } }),
      projects.threads({ headers, params: { id: owned.id }, query: {} }),
      projects.get({ headers, params: { id: elsewhere.id } }),
      projects.threads({ headers, params: { id: elsewhere.id }, query: {} }),
      projects.get({ headers, params: { id: teammates.id } }),
      projects.threads({ headers, params: { id: teammates.id }, query: {} }),
      projects.create({
        headers,
        body: { id: deniedId, eventId: deniedId, name: "Denied" },
      }),
      projects.update({
        headers,
        params: { id: owned.id },
        body: { eventId: projectOperationId(), name: "Renamed" },
      }),
      projects.delete({
        headers,
        params: { id: owned.id },
        body: { eventId: projectOperationId() },
      }),
    ]);

    if (list.status !== 200) {
      throw new Error(`Expected the project list, got ${list.status}`);
    }
    expect(
      list.body.projects.map((project: { readonly id: string }) => {
        return project.id;
      }),
    ).toStrictEqual([owned.id]);
    expect(
      [snapshot, events, ownedProject, ownedThreads].map((response) => {
        return response.status;
      }),
    ).toStrictEqual([200, 200, 200, 200]);
    expect(
      [
        elsewhereProject,
        elsewhereThreads,
        teammateProject,
        teammateThreads,
      ].map((response) => {
        return response.status;
      }),
    ).toStrictEqual([404, 404, 404, 404]);
    expect(
      [created, updated, deleted].map((response) => {
        return response.status;
      }),
    ).toStrictEqual([401, 401, 401]);
  });

  it("native-oauth-002 creates one owned thread for repeated sends with the same client thread ID", async () => {
    const identity = await member();
    const clientThreadId = randomUUID();
    const body = { clientThreadId, title: "Cardputer Zero" };

    const readOnly = await threads.create({
      headers: oauthHeaders(identity, "okou:chat:read"),
      body,
    });
    expect(readOnly.status).toBe(403);

    const sendHeaders = oauthHeaders(identity, "okou:chat:send okou:chat:read");
    const first = await accept(
      threads.create({ headers: sendHeaders, body }),
      [201],
    );
    const second = await accept(
      threads.create({ headers: sendHeaders, body }),
      [201],
    );
    expect([first.body, second.body]).toMatchObject([
      { id: clientThreadId, title: "Cardputer Zero" },
      { id: clientThreadId, title: "Cardputer Zero" },
    ]);
    const metadata = await accept(
      threadMetadata.get({
        headers: sendHeaders,
        params: { id: clientThreadId },
      }),
      [200],
    );
    expect(metadata.body.id).toBe(clientThreadId);
  });

  it("native-oauth-003 reads and marks read only same-workspace owned threads", async () => {
    const identity = await member();
    const otherWorkspace = await seedMember({
      userId: identity.userId,
      orgId: `org_${randomUUID()}`,
    });
    const teammate = await seedMember({
      userId: `user_${randomUUID()}`,
      orgId: identity.orgId,
    });
    const owned = await createThreadAs(identity);
    const elsewhere = await createThreadAs(otherWorkspace);
    const teammates = await createThreadAs(teammate);
    const headers = oauthHeaders(identity, "okou:chat:read");

    const [
      ownedMetadata,
      ownedRead,
      elsewhereMetadata,
      elsewhereRead,
      teammateMetadata,
      teammateRead,
    ] = await Promise.all([
      threadMetadata.get({ headers, params: { id: owned.id } }),
      threadReads.markRead({ headers, params: { id: owned.id } }),
      threadMetadata.get({ headers, params: { id: elsewhere.id } }),
      threadReads.markRead({ headers, params: { id: elsewhere.id } }),
      threadMetadata.get({ headers, params: { id: teammates.id } }),
      threadReads.markRead({ headers, params: { id: teammates.id } }),
    ]);

    if (ownedMetadata.status !== 200 || ownedRead.status !== 200) {
      throw new Error(
        `Expected owned thread access, got ${ownedMetadata.status}/${ownedRead.status}`,
      );
    }
    expect(ownedMetadata.body.id).toBe(owned.id);
    expect(ownedRead.body).toHaveProperty("lastReadAt");
    expect(
      [elsewhereMetadata, elsewhereRead, teammateMetadata, teammateRead].map(
        (response) => {
          return response.status;
        },
      ),
    ).toStrictEqual([404, 404, 404, 404]);
  });

  it("native-oauth-012 bounds chat realtime credentials by the grant's latest redemption time", async () => {
    const issuedAt = Math.floor(now() / 1000) * 1000;
    mockNow(issuedAt);
    const identity = await member();
    signAblyTokenRequests();
    const grantExpiresAt = issuedAt + 7_200_000;

    const response = await accept(
      realtime.create({
        headers: oauthHeaders(identity, "okou:chat:read", 7200),
        body: {},
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      keyName: "app.key",
      timestamp: issuedAt,
      ttl: 3_600_000,
      capability: JSON.stringify({
        [`user-org:${identity.userId}:${identity.orgId}`]: ["subscribe"],
        [`run-output:${identity.userId}:${identity.orgId}:*`]: ["subscribe"],
      }),
      clientId: identity.userId,
      nonce: "signed-nonce",
      mac: "signed-mac",
    });
    expect(
      response.body.timestamp + 120_000 + (response.body.ttl ?? 0),
    ).toBeLessThanOrEqual(grantExpiresAt);
  });

  it("native-oauth-014 rejects a realtime grant with 30 seconds left using the standard envelope", async () => {
    const identity = await member();
    signAblyTokenRequests();

    const response = await accept(
      realtime.create({
        headers: oauthHeaders(identity, "user:org:read okou:chat:read", 30),
        body: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Authentication required", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });
});
