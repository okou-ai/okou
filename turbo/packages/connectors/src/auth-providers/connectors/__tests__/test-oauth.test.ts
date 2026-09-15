import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  buildTestOAuthAuthorizationUrl,
  refreshTestOAuthToken,
} from "../test-oauth/oauth";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const server = setupServer();

function authCodeGrant() {
  return authCodeGrantFixture(["read"], "api");
}

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  server.close();
});

describe("test-oauth provider URLs", () => {
  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", undefined);
    vi.stubEnv("OKOU_WEB_URL", undefined);
    vi.stubEnv("APP_URL", undefined);
    vi.stubEnv("VERCEL_URL", undefined);
  });

  afterEach(() => {
    server.resetHandlers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the API preview alias when the configured URL is a web preview alias", () => {
    vi.stubEnv("APP_URL", "https://{pr}.vm6.ai");
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://pr-12962-www.vm6.ai");
    vi.stubEnv("VERCEL_URL", "pr-12962-api.vm6.ai");

    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        authCodeGrant(),
        "test-client",
        "https://app.okou.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("https://pr-12962-api.vm6.ai");
    expect(authorizationUrl.pathname).toBe(
      "/api/test/oauth-provider/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe("test-client");
    expect(authorizationUrl.searchParams.get("state")).toBe("state-123");
  });

  it("uses the API preview alias when only placeholder config and web Vercel URL are available", () => {
    vi.stubEnv("APP_URL", "https://{pr}.vm6.ai");
    vi.stubEnv("VERCEL_URL", "pr-12962-www.vm6.ai");

    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        authCodeGrant(),
        "test-client",
        "https://app.okou.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("https://pr-12962-api.vm6.ai");
  });

  it("uses the current deployment URL when the API URL is a PR placeholder", () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://{pr}.vm6.ai");
    vi.stubEnv("OKOU_WEB_URL", "https://pr-12962-www.vm6.ai");
    vi.stubEnv("VERCEL_URL", "pr-12962-api.vm6.ai");

    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        authCodeGrant(),
        "test-client",
        "https://app.okou.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("https://pr-12962-api.vm6.ai");
  });

  it("uses the canonical Web URL before the APP_URL fallback", () => {
    vi.stubEnv("OKOU_WEB_URL", "https://pr-12962-www.vm6.ai/");
    vi.stubEnv("APP_URL", "https://app-fallback.example.test");

    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        authCodeGrant(),
        "test-client",
        "https://app.okou.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("https://pr-12962-api.vm6.ai");
  });

  it("sends both Vercel and internal preview bypass headers on refresh", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://pr-12962-www.vm6.ai");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    let tokenRequestHeaders: Headers | undefined;

    server.use(
      http.post(
        "https://pr-12962-api.vm6.ai/api/test/oauth-provider/token",
        ({ request }) => {
          tokenRequestHeaders = request.headers;
          return HttpResponse.json({
            access_token: "access-1",
            refresh_token: "refresh-2",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "read",
          });
        },
      ),
    );

    await refreshTestOAuthToken(
      "test-oauth-client",
      "test-oauth-secret",
      "refresh-1",
      testRefreshSignal(),
    );

    expect(tokenRequestHeaders?.get("x-vercel-protection-bypass")).toBe(
      "preview-secret",
    );
    expect(tokenRequestHeaders?.get("x-okou-test-endpoint-bypass")).toBe(
      "preview-secret",
    );
  });

  it("keeps a concrete configured app URL ahead of VERCEL_URL", () => {
    vi.stubEnv("APP_URL", "https://app.okou.ai");
    vi.stubEnv("VERCEL_URL", "pr-12962-www.vm6.ai");

    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        authCodeGrant(),
        "test-client",
        "https://app.okou.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("https://app.okou.ai");
  });

  it("defaults to localhost when no configured URL is available", () => {
    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        authCodeGrant(),
        "test-client",
        "https://app.okou.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("http://localhost:3000");
  });

  it("fails fast when a PR placeholder has no concrete Vercel URL", () => {
    vi.stubEnv("APP_URL", "https://{pr}.vm6.ai");

    expect(() => {
      buildTestOAuthAuthorizationUrl(
        authCodeGrant(),
        "test-client",
        "https://app.okou.ai/callback",
        "state-123",
      );
    }).toThrow("A concrete test-oauth app URL is required");
  });
});
