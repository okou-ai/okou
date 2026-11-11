import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it, onTestFinished } from "vitest";
import { record, string, unknown as zUnknown } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { connectorAccountRoutes } from "../connector-accounts";
import { agentsRoutes } from "../agents";
import { mockAutomaticMcpOAuthProvider } from "./helpers/api-bdd-connectors";
import { automaticMcpCatalogFixture } from "./helpers/connector-automatic-catalog";

import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...builtinConnectorsAutomaticRoutes,
  ...builtinConnectorsSlugCallbackRoutes,
  ...connectorAccountRoutes,
]);

function automatic() {
  return setupApp({ context, routes })(builtinConnectorAutomaticContract);
}

function accounts() {
  return setupApp({ context, routes })(connectorAccountsContract);
}

function fixture(
  variant:
    | "oauth"
    | "declared-scopes"
    | "provider-prompt"
    | "explicit-prompt" = "oauth",
) {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(actor.userId, actor.orgId);
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  const catalog = automaticMcpCatalogFixture(variant);
  onTestFinished(async () => {
    mocks.clerk.session(actor.userId, actor.orgId);
    const existing = await accept(
      accounts().connections({ headers, query: catalog.target }),
      [200],
    );
    for (const account of existing.body.connections) {
      await accept(
        accounts().delete({
          headers,
          params: { connectionId: account.id },
          body: { target: catalog.target },
        }),
        [200],
      );
    }
  });
  return { ...catalog, ...actor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function begin(f: Fixture, connectionId?: string) {
  return await accept(
    automatic().start({
      headers,
      params: { connectorSlug: f.slug },
      body: {
        authMethod: f.methodId,
        account: connectionId
          ? { intent: "reconnect", connectionId }
          : { intent: "add" },
      },
    }),
    [200],
  );
}

async function beginOAuth(f: Fixture, connectionId?: string) {
  const response = await begin(f, connectionId);
  if (response.body.result !== "authorization") {
    throw new Error("Expected authorization handoff");
  }
  const url = new URL(response.body.authorizationUrl);
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Expected authorization state");
  }
  return { ...response.body, url, state };
}

async function callback(state: string, issuer: string) {
  return await accept(
    automatic().callback({
      query: {
        state,
        code: "authorized-code",
        iss: issuer,
        responseMode: "json",
      },
    }),
    [200],
  );
}

function receipt(f: Fixture, attemptId: string) {
  return accounts().oauthCompletion({
    headers,
    params: { attemptId },
    query: f.target,
  });
}

describe("builtin MCP automatic authentication", () => {
  it.each(
    (["cimd", "dcr"] as const).flatMap((registration) => {
      return [
        [registration, "declared-scopes", "consent"],
        [registration, "provider-prompt", null],
        [registration, "explicit-prompt", "login consent"],
      ] as const;
    }),
  )(
    "uses %s %s authorization policy on connection and exact-account reconnect",
    async (registration, variant, prompt) => {
      const f = fixture(variant);
      const scope = "openid read write offline_access";
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration,
        challengeScope: null,
        metadataScopes: ["openid"],
        authorizationServerScopes: [
          "openid",
          "read",
          "write",
          "admin",
          "offline_access",
        ],
        authorizationCodeScopes: [scope, scope],
        initialExpiresIn: 3600,
      });
      const started = await beginOAuth(f);
      expect(started.url.searchParams.get("scope")).toBe(scope);
      expect(started.url.searchParams.get("prompt")).toBe(prompt);
      expect(Object.fromEntries(started.url.searchParams)).toMatchObject({
        redirect_uri: "https://api.okou.ai/api/connectors/automatic/callback",
        resource: f.endpoint,
        code_challenge_method: "S256",
        response_type: "code",
        state: started.state,
      });
      expect(started.url.searchParams.get("code_challenge")).toMatch(
        /^[\w-]{43}$/u,
      );
      expect((await callback(started.state, provider.issuer)).body.status).toBe(
        "success",
      );
      const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
      const connectionId = completed.body.connectionId;

      const reconnected = await beginOAuth(f, connectionId);
      expect(reconnected.url.searchParams.get("scope")).toBe(scope);
      expect(reconnected.url.searchParams.get("prompt")).toBe(prompt);
      expect(Object.fromEntries(reconnected.url.searchParams)).toMatchObject({
        redirect_uri: "https://api.okou.ai/api/connectors/automatic/callback",
        resource: f.endpoint,
        code_challenge_method: "S256",
        response_type: "code",
        state: reconnected.state,
      });
      expect(reconnected.url.searchParams.get("code_challenge")).toMatch(
        /^[\w-]{43}$/u,
      );
      expect(
        (await callback(reconnected.state, provider.issuer)).body.status,
      ).toBe("success");
      expect(
        (await accept(receipt(f, reconnected.oauthAttemptId), [200])).body,
      ).toStrictEqual(completed.body);
      const connected = await accept(
        accounts().connection({
          headers,
          params: { connectionId },
          query: f.target,
        }),
        [200],
      );
      expect(connected.body.oauthScopes).toStrictEqual(scope.split(" "));
      if (registration === "dcr") {
        expect(provider.registrationBodies).toMatchObject([{ scope }]);
        expect(provider.registrationBodies).toHaveLength(1);
      }
    },
  );

  it.each(["cimd", "dcr"] as const)(
    "uses %s OAuth for mixed public and protected tools",
    async (registration) => {
      const f = fixture("declared-scopes");
      const scope = "openid read write offline_access";
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration,
        authentication: "mixed",
        metadataScopes: ["openid"],
        authorizationServerScopes: [
          "openid",
          "read",
          "write",
          "offline_access",
        ],
        authorizationCodeScopes: [scope],
        initialExpiresIn: 3600,
      });
      const started = await beginOAuth(f);
      expect(started.url.searchParams.get("scope")).toBe(scope);
      expect(started.url.searchParams.get("redirect_uri")).toBe(
        "https://api.okou.ai/api/connectors/automatic/callback",
      );
      expect(started.url.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect((await callback(started.state, provider.issuer)).body.status).toBe(
        "success",
      );
      const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
      const account = await accept(
        accounts().connection({
          headers,
          params: { connectionId: completed.body.connectionId },
          query: f.target,
        }),
        [200],
      );
      expect(account.body).toMatchObject({
        connectionStatus: "connected",
        oauthScopes: scope.split(" "),
      });
    },
  );

  it("connects and reconnects accepted no-auth with its exact catalog method", async () => {
    const f = fixture();
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
    });
    const connected = await begin(f);
    if (connected.body.result !== "connected") {
      throw new Error("Expected immediate no-auth completion");
    }
    const connectionId = connected.body.connectionId;
    expect(connected.body).toStrictEqual({
      result: "connected",
      connectionId,
    });
    const account = await accept(
      accounts().connection({
        headers,
        params: { connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      authMethod: "smart-connect",
      connectionStatus: "connected",
      tokenExpiresAt: null,
      reconnectReason: null,
    });
    expect((await begin(f, connectionId)).body).toStrictEqual(connected.body);
  });

  it("upgrades a public account only after explicit mixed OAuth reconnect and consent", async () => {
    const f = fixture();
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
    });
    const publicConnection = await begin(f);
    if (publicConnection.body.result !== "connected") {
      throw new Error("Expected a public connection");
    }
    const connectionId = publicConnection.body.connectionId;
    const original = await accept(
      accounts().connection({
        headers,
        params: { connectionId },
        query: f.target,
      }),
      [200],
    );
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      metadataScopes: ["read"],
      authorizationCodeScopes: ["read"],
      initialExpiresIn: 3600,
    });
    const started = await beginOAuth(f, connectionId);
    const waiting = await accept(
      accounts().connection({
        headers,
        params: { connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(waiting.body).toStrictEqual(original.body);
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "success",
    );
    expect(
      (await accept(receipt(f, started.oauthAttemptId), [200])).body
        .connectionId,
    ).toBe(connectionId);
    const upgraded = await accept(
      accounts().connection({
        headers,
        params: { connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(upgraded.body).toMatchObject({
      connectionStatus: "connected",
      oauthScopes: ["read"],
    });
  });

  it("preserves an OAuth account when reconnect metadata is unavailable", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      initialExpiresIn: 3600,
    });
    const started = await beginOAuth(f);
    await callback(started.state, provider.issuer);
    const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
    const connectionId = completed.body.connectionId;
    const original = await accept(
      accounts().connection({
        headers,
        params: { connectionId },
        query: f.target,
      }),
      [200],
    );
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      resourceMetadataStatus: 503,
    });
    await accept(
      automatic().start({
        headers,
        params: { connectorSlug: f.slug },
        body: {
          authMethod: f.methodId,
          account: { intent: "reconnect", connectionId },
        },
      }),
      [503],
    );
    expect(
      (
        await accept(
          accounts().connection({
            headers,
            params: { connectionId },
            query: f.target,
          }),
          [200],
        )
      ).body,
    ).toStrictEqual(original.body);
  });

  it("preserves OAuth accepted while an anonymous reconnect was discovering metadata", async () => {
    const f = fixture();
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
    });
    const connected = await begin(f);
    if (connected.body.result !== "connected") {
      throw new Error("Expected a public connection");
    }
    const connectionId = connected.body.connectionId;
    const requested = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    });
    server.use(
      http.get(
        new URL("/.well-known/oauth-protected-resource", f.endpoint).href,
        async () => {
          requested.resolve(undefined);
          await release.promise;
          return new HttpResponse(null, { status: 503 });
        },
      ),
    );
    const pending = Promise.allSettled([
      accept(
        automatic().start({
          headers,
          params: { connectorSlug: f.slug },
          body: {
            authMethod: f.methodId,
            account: { intent: "reconnect", connectionId },
          },
        }),
        [409],
      ),
    ]);
    await requested.promise;
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      initialExpiresIn: 3600,
    });
    const started = await beginOAuth(f, connectionId);
    await callback(started.state, provider.issuer);
    await accept(receipt(f, started.oauthAttemptId), [200]);
    const upgraded = await accept(
      accounts().connection({
        headers,
        params: { connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(upgraded.body.oauthScopes).toStrictEqual(["read", "write"]);
    release.resolve(undefined);
    const [finished] = await pending;
    if (finished.status === "rejected") {
      throw finished.reason;
    }
    expect(
      (
        await accept(
          accounts().connection({
            headers,
            params: { connectionId },
            query: f.target,
          }),
          [200],
        )
      ).body,
    ).toStrictEqual(upgraded.body);
  });

  it("requires OAuth metadata for declared scopes even when initialization is public", async () => {
    const f = fixture("declared-scopes");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      resourceMetadataStatus: 404,
    });
    await accept(
      automatic().start({
        headers,
        params: { connectorSlug: f.slug },
        body: { authMethod: f.methodId, account: { intent: "add" } },
      }),
      [409],
    );
    expect(
      (
        await accept(
          accounts().connections({ headers, query: f.target }),
          [200],
        )
      ).body.connections,
    ).toStrictEqual([]);
  });

  it.each([
    { name: "403 Forbidden", kind: "http", status: 403 },
    { name: "405 Method Not Allowed", kind: "http", status: 405 },
    { name: "503 Service Unavailable", kind: "http", status: 503 },
    { name: "an HTML page", kind: "html", status: 200 },
    { name: "unrelated JSON", kind: "json", status: 200 },
    { name: "no OAuth authority", kind: "no-authority", status: 200 },
  ] as const)(
    "keeps public access when optional metadata returns $name",
    async ({ kind, status }) => {
      const f = fixture();
      mockAutomaticMcpOAuthProvider(context, {
        registration: "none",
        authentication: "none",
      });
      server.use(
        http.get(
          new URL("/.well-known/oauth-protected-resource", f.endpoint).href,
          () => {
            switch (kind) {
              case "http": {
                return new HttpResponse(null, { status });
              }
              case "html": {
                return new HttpResponse(
                  "<!doctype html><title>Not found</title>",
                  {
                    headers: { "content-type": "text/html" },
                  },
                );
              }
              case "json": {
                return HttpResponse.json({ status: "ok" });
              }
              case "no-authority": {
                return HttpResponse.json({ resource: f.endpoint });
              }
            }
          },
        ),
      );
      const connected = await begin(f);
      expect(connected.body).toMatchObject({
        result: "connected",
        connectionId: expect.any(String),
      });
      if (connected.body.result !== "connected") {
        throw new Error("Expected a public connection");
      }
      const account = await accept(
        accounts().connection({
          headers,
          params: { connectionId: connected.body.connectionId },
          query: f.target,
        }),
        [200],
      );
      expect(account.body).toMatchObject({
        connectionStatus: "connected",
        oauthScopes: null,
      });
    },
  );

  it.each([
    {
      name: "required OAuth discovery failure",
      variant: "declared-scopes",
      status: 503,
      resourceMetadataStatus: 503,
      resource: undefined,
    },
    {
      name: "foreign resource metadata",
      variant: "oauth",
      status: 409,
      resourceMetadataStatus: undefined,
      resource: "https://foreign-mcp.example.test/",
    },
  ] as const)(
    "rejects $name after public initialization",
    async ({ variant, status, resourceMetadataStatus, resource }) => {
      const f = fixture(variant);
      mockAutomaticMcpOAuthProvider(context, {
        registration: "cimd",
        authentication: "mixed",
        resourceMetadataStatus,
        resource,
      });
      await accept(
        automatic().start({
          headers,
          params: { connectorSlug: f.slug },
          body: { authMethod: f.methodId, account: { intent: "add" } },
        }),
        [status],
      );
      expect(
        (
          await accept(
            accounts().connections({ headers, query: f.target }),
            [200],
          )
        ).body.connections,
      ).toStrictEqual([]);
    },
  );

  it.each([
    { variant: "oauth", expectedStatus: 200 },
    { variant: "declared-scopes", expectedStatus: 409 },
  ] as const)(
    "handles optional discovery network failure for $variant",
    async ({ variant, expectedStatus }) => {
      const f = fixture(variant);
      mockAutomaticMcpOAuthProvider(context, {
        registration: "cimd",
        authentication: "mixed",
      });
      server.use(
        http.get(
          new URL("/.well-known/oauth-protected-resource", f.endpoint).href,
          () => {
            return HttpResponse.error();
          },
        ),
      );
      const response = await accept(
        automatic().start({
          headers,
          params: { connectorSlug: f.slug },
          body: { authMethod: f.methodId, account: { intent: "add" } },
        }),
        [expectedStatus],
      );
      const connections = (
        await accept(
          accounts().connections({ headers, query: f.target }),
          [200],
        )
      ).body.connections;
      if (response.status === 200) {
        expect(response.body.result).toBe("connected");
        expect(connections).toMatchObject([
          { connectionStatus: "connected", oauthScopes: null },
        ]);
      } else {
        expect(connections).toStrictEqual([]);
      }
    },
  );

  it("requires OAuth after a challenge even when resource discovery is unavailable", async () => {
    const f = fixture();
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      resourceMetadataStatus: 503,
    });
    await accept(
      automatic().start({
        headers,
        params: { connectorSlug: f.slug },
        body: { authMethod: f.methodId, account: { intent: "add" } },
      }),
      [503],
    );
    expect(
      (
        await accept(
          accounts().connections({ headers, query: f.target }),
          [200],
        )
      ).body.connections,
    ).toStrictEqual([]);
  });

  it.each([false, true])(
    "bounds stalled optional metadata without losing OAuth (reconnect: %s)",
    async (reconnectOAuth) => {
      const f = fixture();
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration: reconnectOAuth ? "cimd" : "none",
        authentication: reconnectOAuth ? "mixed" : "none",
        initialExpiresIn: 3600,
      });
      let connectionId: string | undefined;
      if (reconnectOAuth) {
        const started = await beginOAuth(f);
        await callback(started.state, provider.issuer);
        connectionId = (await accept(receipt(f, started.oauthAttemptId), [200]))
          .body.connectionId;
      }
      const original = await accept(
        accounts().connections({ headers, query: f.target }),
        [200],
      );
      const requested = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      const deadline = new AbortController();
      context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
        return milliseconds === 5000 ? deadline.signal : undefined;
      });
      server.use(
        http.get(
          new URL("/.well-known/oauth-protected-resource", f.endpoint).href,
          async () => {
            requested.resolve(undefined);
            await release.promise;
            return new HttpResponse(null, { status: 503 });
          },
        ),
      );
      const pending = Promise.allSettled([
        accept(
          automatic().start({
            headers,
            params: { connectorSlug: f.slug },
            body: {
              authMethod: f.methodId,
              account: connectionId
                ? { intent: "reconnect", connectionId }
                : { intent: "add" },
            },
          }),
          [200, 503],
        ),
      ]);
      await requested.promise;
      deadline.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
      const [finished] = await pending;
      release.resolve(undefined);
      if (finished.status === "rejected") {
        throw finished.reason;
      }
      expect(finished.value.status).toBe(reconnectOAuth ? 503 : 200);
      const current = await accept(
        accounts().connections({ headers, query: f.target }),
        [200],
      );
      if (reconnectOAuth) {
        expect(current.body).toStrictEqual(original.body);
      } else {
        expect(current.body.connections).toMatchObject([
          { connectionStatus: "connected", oauthScopes: null },
        ]);
      }
    },
  );

  it("rejects unsafe optional metadata redirects after public initialization", async () => {
    const f = fixture();
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
    });
    server.use(
      http.get(
        new URL("/.well-known/oauth-protected-resource", f.endpoint).href,
        () => {
          return new HttpResponse(null, {
            status: 302,
            headers: { location: "http://metadata.example.test/metadata" },
          });
        },
      ),
    );
    await accept(
      automatic().start({
        headers,
        params: { connectorSlug: f.slug },
        body: { authMethod: f.methodId, account: { intent: "add" } },
      }),
      [400],
    );
    expect(
      (
        await accept(
          accounts().connections({ headers, query: f.target }),
          [200],
        )
      ).body.connections,
    ).toStrictEqual([]);
  });

  it("does not downgrade an advertised OAuth authority when AS discovery fails", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
    });
    server.use(
      http.get(
        `${provider.issuer}/.well-known/oauth-authorization-server`,
        () => {
          return new HttpResponse(null, { status: 503 });
        },
      ),
      http.get(`${provider.issuer}/.well-known/openid-configuration`, () => {
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await accept(
      automatic().start({
        headers,
        params: { connectorSlug: f.slug },
        body: { authMethod: f.methodId, account: { intent: "add" } },
      }),
      [503],
    );
    expect(
      (
        await accept(
          accounts().connections({ headers, query: f.target }),
          [200],
        )
      ).body.connections,
    ).toStrictEqual([]);
  });

  it("publishes two concurrent no-auth accounts with exactly one default", async () => {
    const f = fixture();
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
    });
    const attempts = await Promise.allSettled([begin(f), begin(f)]);
    const ids = attempts.map((attempt) => {
      if (attempt.status === "rejected") {
        throw attempt.reason;
      }
      if (attempt.value.body.result !== "connected") {
        throw new Error("Expected immediate no-auth completion");
      }
      return attempt.value.body.connectionId;
    });
    expect(new Set(ids).size).toBe(2);
    const listed = await accept(
      accounts().connections({ headers, query: f.target }),
      [200],
    );
    expect(
      listed.body.connections
        .map((account) => {
          return account.id;
        })
        .sort(),
    ).toStrictEqual([...ids].sort());
    expect(
      listed.body.connections.filter((account) => {
        return account.isDefault;
      }),
    ).toHaveLength(1);
    for (const account of listed.body.connections) {
      expect(account).toMatchObject({
        authMethod: f.methodId,
        connectionStatus: "connected",
      });
    }
  });

  it("rejects discovery metadata whose issuer differs from the requested issuer", async () => {
    const f = await fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      metadataIssuer: "https://different-issuer.example.test",
    });
    await accept(
      automatic().start({
        headers,
        params: { connectorSlug: f.slug },
        body: { authMethod: f.methodId, account: { intent: "add" } },
      }),
      [409],
    );
    expect(provider.tokenBodies).toHaveLength(0);
    expect(
      (
        await accept(
          accounts().connections({ headers, query: f.target }),
          [200],
        )
      ).body.connections,
    ).toStrictEqual([]);
  });

  it("completes parent-resource CIMD OAuth through the fixed callback and exact receipt", async () => {
    const f = fixture();
    const resource = new URL(f.endpoint).origin;
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      resource,
    });
    const started = await beginOAuth(f);
    expect(started.url.searchParams.get("resource")).toBe(resource);
    expect(started.url.searchParams.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/connectors/automatic/callback",
    );
    expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
    await accept(receipt(f, started.oauthAttemptId), [404]);
    expect((await callback(started.state, provider.issuer)).body).toStrictEqual(
      {
        status: "success",
        username: null,
      },
    );
    const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
    const account = await accept(
      accounts().connection({
        headers,
        params: { connectionId: completed.body.connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      authMethod: f.methodId,
      connectionStatus: "connected",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: ["read", "write"],
    });
    expect(provider.tokenBodies[0]?.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/connectors/automatic/callback",
    );
    expect(provider.tokenBodies[0]?.get("resource")).toBe(resource);
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "error",
    );
    mocks.clerk.session(`user_${randomUUID()}`, f.orgId);
    await accept(receipt(f, started.oauthAttemptId), [404]);
    mocks.clerk.session(f.userId, f.orgId);
  });

  it("notifies account readers when the authorization target is deleted during OAuth", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    context.mocks.s3.send.mockResolvedValue({});
    const agentApi = setupApp({ context, routes: agentsRoutes });
    const agent = await accept(
      agentApi(agentsMainContract).create({
        headers,
        body: { displayName: "OAuth target", visibility: "private" },
      }),
      [201],
    );
    const started = await accept(
      automatic().start({
        headers,
        params: { connectorSlug: f.slug },
        body: {
          authMethod: f.methodId,
          account: { intent: "add" },
          agentId: agent.body.agentId,
        },
      }),
      [200],
    );
    if (started.body.result !== "authorization") {
      throw new Error("Expected authorization handoff");
    }
    const state = new URL(started.body.authorizationUrl).searchParams.get(
      "state",
    );
    if (!state) {
      throw new Error("Expected authorization state");
    }
    await accept(
      agentApi(agentsByIdContract).delete({
        headers,
        params: { id: agent.body.agentId },
      }),
      [204],
    );
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();

    expect((await callback(state, provider.issuer)).body).toStrictEqual({
      status: "error",
      message: `Agent not found: ${agent.body.agentId}`,
    });
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `user:${f.userId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledExactlyOnceWith(
      "connector:changed",
      { connectorSlug: f.slug },
    );
    const saved = await accept(
      accounts().connections({ headers, query: f.target }),
      [200],
    );
    expect(saved.body.connections).toHaveLength(1);
    expect(saved.body.connections[0]).toMatchObject({
      authMethod: f.methodId,
      connectionStatus: "connected",
    });
    await accept(receipt(f, started.body.oauthAttemptId), [404]);
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
  });

  it("persists a verified OIDC identity without expanding scopes", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      identity: {
        subject: "automatic-user-123",
        tokenUsername: "token-user",
        tokenEmail: "token-user@example.test",
        userInfoUsername: "userinfo-user",
        userInfoEmail: "userinfo-user@example.test",
      },
    });
    const started = await beginOAuth(f);
    expect(started.url.searchParams.get("scope")).toBe("read write");
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
    const account = await accept(
      accounts().connection({
        headers,
        params: { connectionId: completed.body.connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      externalId: "automatic-user-123",
      externalUsername: "userinfo-user",
      externalEmail: "userinfo-user@example.test",
    });
  });

  it("keeps verified identity when an optional ID-token label is oversized", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      identity: {
        subject: "automatic-bounded-label-user",
        tokenUsername: "x".repeat(256),
        tokenEmail: "bounded-label-user@example.test",
      },
    });
    const started = await beginOAuth(f);
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
    const account = await accept(
      accounts().connection({
        headers,
        params: { connectionId: completed.body.connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      externalId: "automatic-bounded-label-user",
      externalUsername: "bounded-label-user@example.test",
      externalEmail: "bounded-label-user@example.test",
    });
  });

  it("keeps a successful connection unnamed for a future-issued ID token", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      identity: {
        subject: "future-issued-user",
        tokenIssuedAtOffsetSeconds: 300,
      },
    });
    const started = await beginOAuth(f);
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
    const account = await accept(
      accounts().connection({
        headers,
        params: { connectionId: completed.body.connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      externalId: null,
      externalUsername: null,
      externalEmail: null,
    });
  });

  it("keeps a successful connection unnamed when its ID token is invalid", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      identity: {
        subject: "untrusted-user",
        tokenUsername: "untrusted-name",
        tokenEmail: "untrusted@example.test",
        invalidIdToken: true,
      },
    });
    const started = await beginOAuth(f);
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
    const account = await accept(
      accounts().connection({
        headers,
        params: { connectionId: completed.body.connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      externalId: null,
      externalUsername: null,
      externalEmail: null,
    });
  });

  it.each([
    {
      name: "public-only",
      method: "none",
      advertised: ["none"],
      requested: "none",
    },
    {
      name: "public with an unsupported alternative",
      method: "none",
      advertised: ["private_key_jwt", "none"],
      requested: "none",
    },
    {
      name: "public and confidential basic",
      method: "client_secret_basic",
      advertised: ["none", "client_secret_basic"],
      requested: "client_secret_basic",
    },
    {
      name: "public and confidential post",
      method: "client_secret_post",
      advertised: ["none", "client_secret_post"],
      requested: "client_secret_post",
    },
    {
      name: "all implemented methods in reverse preference order",
      method: "client_secret_basic",
      advertised: ["none", "client_secret_post", "client_secret_basic"],
      requested: "client_secret_basic",
    },
    {
      name: "provider-selected public authentication",
      method: "none",
      advertised: ["client_secret_basic", "none"],
      requested: "client_secret_basic",
    },
    {
      name: "provider-selected confidential post authentication",
      method: "client_secret_post",
      advertised: ["client_secret_basic", "client_secret_post"],
      requested: "client_secret_basic",
    },
    {
      name: "provider-selected public authentication omitted from discovery",
      method: "none",
      advertised: ["client_secret_basic", "client_secret_post"],
      requested: "client_secret_basic",
    },
    {
      name: "provider-selected confidential post omitted from discovery",
      method: "client_secret_post",
      advertised: ["client_secret_basic"],
      requested: "client_secret_basic",
    },
    {
      name: "provider-selected confidential basic omitted from discovery",
      method: "client_secret_basic",
      advertised: ["client_secret_post"],
      requested: "client_secret_post",
    },
    {
      name: "unspecified authentication",
      method: "client_secret_basic",
      advertised: null,
      requested: undefined,
    },
  ] as const)(
    "connects and reuses a $name DCR client with a long opaque ID and issuer binding",
    async ({ method, advertised, requested }) => {
      const f = fixture();
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration: "dcr",
        dcrClientId: `automatic-dcr-client-${"x".repeat(1024)}`,
        dcrTokenEndpointAuthMethod: method,
        tokenEndpointAuthMethodsSupported: advertised,
        ...(advertised ? { dcrDefaultTokenEndpointAuthMethod: "none" } : {}),
      });
      const rejected = await beginOAuth(f);
      expect(
        (await callback(rejected.state, "https://other.example.test")).body
          .status,
      ).toBe("error");
      await accept(receipt(f, rejected.oauthAttemptId), [404]);
      const started = await beginOAuth(f);
      expect((await callback(started.state, provider.issuer)).body.status).toBe(
        "success",
      );
      const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
      const reconnect = await beginOAuth(f, completed.body.connectionId);
      expect(
        (await callback(reconnect.state, provider.issuer)).body.status,
      ).toBe("success");
      expect(
        (await accept(receipt(f, reconnect.oauthAttemptId), [200])).body,
      ).toStrictEqual(completed.body);
      expect(provider.registrationBodies).toHaveLength(1);
      expect(provider.registrationBodies[0]?.token_endpoint_auth_method).toBe(
        requested,
      );
    },
  );

  it("connects and reuses a DCR client with millisecond issuance and expiry", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      dcrClientIdIssuedAt: now() - 1000,
      dcrClientSecretExpiresAt: now() + 60 * 60 * 1000,
    });
    const first = await beginOAuth(f);
    expect((await callback(first.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const completed = await accept(receipt(f, first.oauthAttemptId), [200]);
    const second = await beginOAuth(f, completed.body.connectionId);
    expect((await callback(second.state, provider.issuer)).body.status).toBe(
      "success",
    );
    expect(provider.registrationBodies).toHaveLength(1);
  });

  it.each(["none", "client_secret_basic"] as const)(
    "infers %s authentication when registration omits the method",
    async (method) => {
      const f = fixture();
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration: "dcr",
        dcrTokenEndpointAuthMethod: method,
      });
      server.use(
        http.post(`${provider.issuer}/register`, async ({ request }) => {
          const metadata = record(string(), zUnknown()).parse(
            await request.json(),
          );
          delete metadata.token_endpoint_auth_method;
          return HttpResponse.json({
            ...metadata,
            client_id: "automatic-dcr-client",
            ...(method === "none"
              ? {}
              : { client_secret: "automatic-dcr-secret" }),
          });
        }),
      );

      const started = await beginOAuth(f);
      expect((await callback(started.state, provider.issuer)).body.status).toBe(
        "success",
      );
      const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
      const account = await accept(
        accounts().connection({
          headers,
          params: { connectionId: completed.body.connectionId },
          query: f.target,
        }),
        [200],
      );
      expect(account.body.connectionStatus).toBe("connected");
    },
  );

  it.each([
    {
      name: "unsupported authentication",
      registration: { token_endpoint_auth_method: "private_key_jwt" },
    },
    {
      name: "public authentication with a client secret",
      registration: {
        token_endpoint_auth_method: "none",
        client_secret: "unexpected-secret",
      },
    },
    {
      name: "confidential authentication without a client secret",
      registration: { token_endpoint_auth_method: "client_secret_basic" },
    },
    {
      name: "no declared method or compatible credentials",
      registration: {},
    },
  ])(
    "rejects DCR $name without creating an account",
    async ({ registration }) => {
      const f = fixture();
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration: "dcr",
        tokenEndpointAuthMethodsSupported: [
          "client_secret_basic",
          "client_secret_post",
        ],
      });
      server.use(
        http.post(`${provider.issuer}/register`, async ({ request }) => {
          const metadata = record(string(), zUnknown()).parse(
            await request.json(),
          );
          delete metadata.token_endpoint_auth_method;
          return HttpResponse.json({
            ...metadata,
            client_id: "invalid-authentication-client",
            ...registration,
          });
        }),
      );

      const rejected = await accept(
        automatic().start({
          headers,
          params: { connectorSlug: f.slug },
          body: { authMethod: f.methodId, account: { intent: "add" } },
        }),
        [409],
      );
      expect(rejected.body).toMatchObject({ error: { code: "CONFLICT" } });
      const listed = await accept(
        accounts().connections({ headers, query: f.target }),
        [200],
      );
      expect(listed.body.connections).toStrictEqual([]);
    },
  );

  it("does not resurrect an account deleted during its reconnect token exchange", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    const initial = await beginOAuth(f);
    await callback(initial.state, provider.issuer);
    const receiptResult = await accept(
      receipt(f, initial.oauthAttemptId),
      [200],
    );
    const connectionId = receiptResult.body.connectionId;
    const reconnect = await beginOAuth(f, connectionId);
    server.use(
      http.post(`${provider.issuer}/token`, async () => {
        await accept(
          accounts().delete({
            headers,
            params: { connectionId },
            body: { target: f.target },
          }),
          [200],
        );
        return HttpResponse.json({
          access_token: "deleted-account-access-token",
          refresh_token: "deleted-account-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }),
    );
    expect((await callback(reconnect.state, provider.issuer)).body.status).toBe(
      "error",
    );
    await accept(receipt(f, reconnect.oauthAttemptId), [404]);
    expect(
      (
        await accept(
          accounts().connections({ headers, query: f.target }),
          [200],
        )
      ).body.connections,
    ).toStrictEqual([]);
  });

  it("consumes cancellation without accepting a subsequent authorization code", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    const started = await beginOAuth(f);
    const cancelled = await accept(
      automatic().callback({
        query: {
          state: started.state,
          error: "access_denied",
          responseMode: "json",
        },
      }),
      [200],
    );
    expect(cancelled.body.status).toBe("error");
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "error",
    );
    await accept(receipt(f, started.oauthAttemptId), [404]);
  });
});
