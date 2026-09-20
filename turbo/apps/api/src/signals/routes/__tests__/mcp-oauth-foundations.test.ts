import { mcpOAuthContract } from "@okouai/api-contracts/contracts/mcp-oauth";
import {
  testMcpOAuthFetchContract,
  type TestMcpOAuthFetchRequest,
} from "@okouai/api-contracts/contracts/test-mcp-oauth-fetch";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { mcpOAuthClientMetadataRoutes } from "../mcp-oauth-client-metadata";
import { testMcpOAuthFetchRoutes } from "../test-mcp-oauth-fetch";

const context = testContext();

function metadataClient(baseUrl = "http://api.test") {
  return setupApp({
    baseUrl,
    context,
    routes: mcpOAuthClientMetadataRoutes,
  })(mcpOAuthContract);
}

function probeClient() {
  return setupApp({ context, routes: testMcpOAuthFetchRoutes })(
    testMcpOAuthFetchContract,
  );
}

function allowPublicHost(hostname: string, address = "8.8.8.8"): void {
  context.mocks.dns.lookupOverrides.set(hostname, [{ address, family: 4 }]);
}

async function requestProbeSuccess(body: TestMcpOAuthFetchRequest) {
  return await accept(probeClient().request({ body }), [200]);
}

async function requestProbeFailure(body: TestMcpOAuthFetchRequest) {
  return await accept(probeClient().request({ body }), [502]);
}

describe("MCP OAuth foundations", () => {
  it("publishes exact public Okou client metadata from configured origins", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");

    const response = await accept(metadataClient().okouClientMetadata(), [200]);

    expect(response.body).toStrictEqual({
      client_id: "https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json",
      client_name: "Okou",
      client_uri: "https://app.okou.ai/",
      redirect_uris: [
        "https://app.okou.ai/connectors/custom/callback",
        "https://api.okou.ai/api/connectors/automatic/callback",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
    });
  });

  it("does not let the request host change the Okou client identity", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");

    const response = await accept(
      metadataClient("https://attacker.example.com").okouClientMetadata(),
      [200],
    );

    expect(response.body.client_id).toBe(
      "https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json",
    );
    expect(response.body.client_uri).toBe("https://app.okou.ai/");
    expect(response.body.redirect_uris).toStrictEqual([
      "https://app.okou.ai/connectors/custom/callback",
      "https://api.okou.ai/api/connectors/automatic/callback",
    ]);
  });

  it("supports OAuth metadata and SDK request body shapes with DNS pinning", async () => {
    allowPublicHost("oauth.example.com");
    server.use(
      http.get("https://oauth.example.com/metadata", ({ request }) => {
        return HttpResponse.json({ method: request.method });
      }),
      http.head("https://oauth.example.com/metadata", () => {
        return new HttpResponse(null, {
          status: 200,
          headers: { "x-oauth-metadata": "present" },
        });
      }),
      http.post("https://oauth.example.com/token", async ({ request }) => {
        return HttpResponse.json({
          contentType: request.headers.get("content-type"),
          body: await request.text(),
        });
      }),
    );

    const metadata = await requestProbeSuccess({
      url: "https://oauth.example.com/metadata",
      method: "GET",
    });
    const head = await requestProbeSuccess({
      url: "https://oauth.example.com/metadata",
      method: "HEAD",
    });
    const form = await requestProbeSuccess({
      url: "https://oauth.example.com/token",
      method: "POST",
      bodyKind: "form",
      body: "grant_type=authorization_code&code=code_test",
    });
    const json = await requestProbeSuccess({
      url: "https://oauth.example.com/token",
      method: "POST",
      bodyKind: "json",
      body: '{"redirect_uris":["https://app.okou.ai/callback"]}',
    });

    expect(metadata).toMatchObject({ status: 200 });
    expect(metadata.body).toMatchObject({ status: 200 });
    expect(JSON.parse(metadata.body.body)).toStrictEqual({ method: "GET" });
    expect(head.body).toMatchObject({
      status: 200,
      body: "",
      headers: expect.objectContaining({ "x-oauth-metadata": "present" }),
    });
    expect(JSON.parse(form.body.body)).toStrictEqual({
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      body: "grant_type=authorization_code&code=code_test",
    });
    expect(JSON.parse(json.body.body)).toStrictEqual({
      contentType: "application/json",
      body: '{"redirect_uris":["https://app.okou.ai/callback"]}',
    });
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.8.8",
      "8.8.8.8",
      "8.8.8.8",
      "8.8.8.8",
    ]);
  });

  it.each([
    "http://oauth.example.com/metadata",
    "https://user:password@oauth.example.com/metadata",
    "https://oauth.example.com/metadata#fragment",
    "https://localhost/metadata",
    "https://internal/metadata",
  ])("rejects unsafe OAuth URL %s", async (url) => {
    allowPublicHost("oauth.example.com");

    const response = await requestProbeFailure({ url, method: "GET" });

    expect(response.status).toBe(502);
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([]);
  });

  it("rejects the whole DNS answer set when one address is private", async () => {
    context.mocks.dns.lookupOverrides.set("mixed.example.com", [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);

    const response = await requestProbeFailure({
      url: "https://mixed.example.com/metadata",
      method: "GET",
    });

    expect(response.status).toBe(502);
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([]);
  });

  it("follows three metadata redirects and pins every hop", async () => {
    allowPublicHost("oauth.example.com");
    server.use(
      http.get("https://oauth.example.com/redirect/:step", ({ params }) => {
        const step = Number(params.step);
        return step < 3
          ? new HttpResponse(null, {
              status: 302,
              headers: { location: `/redirect/${step + 1}` },
            })
          : HttpResponse.json({ issuer: "https://oauth.example.com" });
      }),
    );

    const response = await requestProbeSuccess({
      url: "https://oauth.example.com/redirect/0",
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe(200);
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.8.8",
      "8.8.8.8",
      "8.8.8.8",
      "8.8.8.8",
    ]);
  });

  it("rejects a fourth metadata redirect", async () => {
    allowPublicHost("oauth.example.com");
    server.use(
      http.get("https://oauth.example.com/redirect/:step", ({ params }) => {
        const step = Number(params.step);
        return new HttpResponse(null, {
          status: 302,
          headers: { location: `/redirect/${step + 1}` },
        });
      }),
    );

    const response = await requestProbeFailure({
      url: "https://oauth.example.com/redirect/0",
      method: "GET",
    });

    expect(response.status).toBe(502);
    expect(response.body).toStrictEqual({
      error: "MCP OAuth response has too many redirects",
    });
    expect(context.mocks.nodeRequest.pinnedAddresses).toHaveLength(4);
  });

  it("revalidates a metadata redirect target before fetching it", async () => {
    allowPublicHost("oauth.example.com");
    context.mocks.dns.lookupOverrides.set("private.example.com", [
      { address: "10.0.0.1", family: 4 },
    ]);
    server.use(
      http.get("https://oauth.example.com/redirect", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { location: "https://private.example.com/metadata" },
        });
      }),
    );

    const response = await requestProbeFailure({
      url: "https://oauth.example.com/redirect",
      method: "GET",
    });

    expect(response.status).toBe(502);
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.8.8",
    ]);
  });

  it("removes authorization before a metadata redirect", async () => {
    allowPublicHost("oauth.example.com");
    allowPublicHost("metadata.example.com", "1.1.1.1");
    server.use(
      http.get("https://oauth.example.com/redirect", ({ request }) => {
        return request.headers.get("authorization") === "Bearer secret"
          ? new HttpResponse(null, {
              status: 302,
              headers: {
                location: "https://metadata.example.com/document",
              },
            })
          : new HttpResponse(null, { status: 400 });
      }),
      http.get("https://metadata.example.com/document", ({ request }) => {
        return HttpResponse.json({
          authorization: request.headers.get("authorization"),
        });
      }),
    );

    const response = await requestProbeSuccess({
      url: "https://oauth.example.com/redirect",
      method: "GET",
      authorization: "Bearer secret",
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.body)).toStrictEqual({
      authorization: null,
    });
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.8.8",
      "1.1.1.1",
    ]);
  });

  it("rejects token and DCR POST redirects without replay", async () => {
    allowPublicHost("oauth.example.com");
    server.use(
      http.post("https://oauth.example.com/token", () => {
        return new HttpResponse(null, {
          status: 307,
          headers: { location: "/redirected-token" },
        });
      }),
    );

    const response = await requestProbeFailure({
      url: "https://oauth.example.com/token",
      method: "POST",
      bodyKind: "form",
      body: "grant_type=refresh_token&refresh_token=secret",
      authorization: "Basic secret",
    });

    expect(response.status).toBe(502);
    expect(response.body).toStrictEqual({
      error: "MCP OAuth POST redirects are not allowed",
    });
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.8.8",
    ]);
  });

  it("enforces header and response body size limits", async () => {
    allowPublicHost("oauth.example.com");
    server.use(
      http.get("https://oauth.example.com/large-header", () => {
        return HttpResponse.json(
          { ok: true },
          { headers: { "x-large": "x".repeat(17 * 1024) } },
        );
      }),
      http.get("https://oauth.example.com/large-body", () => {
        return HttpResponse.text("x".repeat(64 * 1024 + 1));
      }),
    );

    const header = await requestProbeFailure({
      url: "https://oauth.example.com/large-header",
      method: "GET",
    });
    const body = await requestProbeFailure({
      url: "https://oauth.example.com/large-body",
      method: "GET",
    });

    expect(header.status).toBe(502);
    expect(header.body).toStrictEqual({
      error: "Parse Error: Header overflow",
    });
    expect(body.status).toBe(502);
    expect(body.body).toStrictEqual({
      error: "MCP OAuth response is too large",
    });
  });

  it("honors caller cancellation and the transport deadline", async () => {
    allowPublicHost("oauth.example.com");

    const cancelled = await requestProbeFailure({
      url: "https://oauth.example.com/metadata",
      method: "GET",
      cancel: true,
    });

    expect(cancelled.status).toBe(502);

    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 10_000 ? AbortSignal.abort() : undefined;
    });
    const timedOut = await requestProbeFailure({
      url: "https://oauth.example.com/metadata",
      method: "GET",
    });

    expect(timedOut.status).toBe(502);
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([]);
  });
});
