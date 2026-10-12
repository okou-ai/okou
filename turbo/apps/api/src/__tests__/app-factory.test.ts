import {
  CLIENT_FORCE_UPGRADE_STATUS,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  CLIENT_TYPE_IOS,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { createApp } from "../app-factory";
import { mockEnv } from "../lib/env";
import webClientCompatibility from "../lib/web-client-compatibility.json";
import { healthRoutes } from "../signals/routes/health";
import { mailRoutes } from "../signals/routes/mail";
import { iosClientCompatibility, testContext } from "./test-context";

const TEST_APP_ROUTES = Object.freeze([...healthRoutes, ...mailRoutes]);

const MINIMUM_WEB_CLIENT_VERSION =
  webClientCompatibility.minimumSupportedVersion;
// Derived so that raising the supported floor does not turn this fixture into
// an unsupported version.
const NEWER_WEB_CLIENT_VERSION = MINIMUM_WEB_CLIENT_VERSION.replace(
  /(\d+)$/u,
  (patch) => {
    return (Number(patch) + 1).toString();
  },
);

describe("createApp", () => {
  const context = testContext();

  describe("not found", () => {
    it.each([
      [
        "/sign-in?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect",
        "https://pr-123-app.vm6.ai/sign-in?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect",
      ],
      [
        "/sign-up/verify?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect",
        "https://pr-123-app.vm6.ai/sign-up/verify?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect",
      ],
    ])("redirects %s to the configured app origin", async (path, expected) => {
      mockEnv("APP_URL", "https://pr-123-app.vm6.ai");
      mockEnv("OKOU_WEB_URL", "https://pr-123-www.omby.ai");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request(`https://pr-123-api.vm6.ai${path}`);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(expected);
    });

    it.each([
      [
        "https://api.okou.ai",
        "https://app.okou.ai",
        "/sign-in?redirect_url=%2Fchats",
        "https://app.okou.ai/sign-in?redirect_url=%2Fchats",
      ],
      [
        "https://api.okou.ai",
        "https://app.okou.ai",
        "/sign-up/verify?redirect_url=%2Fonboarding",
        "https://app.okou.ai/sign-up/verify?redirect_url=%2Fonboarding",
      ],
    ])(
      "redirects auth requests on %s to its matching app domain",
      async (apiUrl, configuredAppUrl, path, expected) => {
        mockEnv("APP_URL", configuredAppUrl);
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });

        const response = await app.request(`${apiUrl}${path}`);

        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(expected);
      },
    );

    it("returns a 404 JSON response for unmatched routes", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/api/legacy/fallthrough?limit=5", {
        method: "GET",
        headers: { authorization: "Bearer legacy" },
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Not found",
      });
    });

    it("keeps registered routes matched normally", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", { method: "GET" });

      expect(response.status).toBe(200);
    });
  });

  describe("preview automation bypass", () => {
    it("rejects preview requests without the Vercel bypass header or cookie", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      const response = await app.request("/health", { method: "GET" });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Preview automation bypass required",
        debug: {
          expected: "582906dc0bca",
          cookieHeaderPresent: false,
        },
      });
    });

    it("allows preview requests with the matching Vercel bypass header", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      const response = await app.request("/health", {
        method: "GET",
        headers: { "x-vercel-protection-bypass": "preview-secret" },
      });

      expect(response.status).toBe(200);
    });

    it("allows preview requests with a matching Vercel bypass cookie", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      const response = await app.request("/health", {
        method: "GET",
        headers: {
          cookie: "unrelated=1; x-vercel-protection-bypass=preview-secret",
        },
      });

      expect(response.status).toBe(200);
    });

    it("rejects preview requests with the bypass secret in an unrelated cookie", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      const response = await app.request("/health", {
        method: "GET",
        headers: { cookie: "unrelated=preview-secret" },
      });

      expect(response.status).toBe(403);
    });

    it("allows preview requests with the matching Vercel bypass query", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      const response = await app.request(
        "/health?x-vercel-protection-bypass=preview-secret",
        { method: "GET" },
      );

      expect(response.status).toBe(200);
    });

    it("exempts external webhook paths from the guard without the bypass secret", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      // A non-webhook path is still rejected by the guard before route matching.
      const guarded = await app.request("/api/legacy/fallthrough", {
        method: "GET",
      });
      expect(guarded.status).toBe(403);

      // Stripe (and every other) webhook is exempt, so the request reaches
      // routing instead of the guard. GET does not match the POST-only handler,
      // yielding a normal 404 rather than a bypass rejection — proof the
      // server-to-server webhook would have reached its handler.
      const webhook = await app.request("/api/webhooks/stripe", {
        method: "GET",
      });
      expect(webhook.status).toBe(404);
      await expect(webhook.json()).resolves.toStrictEqual({
        error: "Not found",
      });
    });
  });

  describe("cors", () => {
    it("echoes allowed cross-origin on registered route responses", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://app.okou.ai" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.okou.ai",
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );
    });

    it("echoes exact vm7 app origin with port on registered route responses", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://app.vm7.ai:8443" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.vm7.ai:8443",
      );
    });

    it("echoes the exact okou.ai production origin", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://okou.ai" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://okou.ai",
      );
    });

    it("allows https origins on okou.ai subdomains", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://console.okou.ai" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://console.okou.ai",
      );
    });

    it("does not allow lookalike okou.ai origins", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://okou.ai.evil.example" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("answers preflight without invoking the route handler", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/api/chat-threads", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.okou.ai",
          "access-control-request-method": "GET",
          "access-control-request-headers":
            "authorization,x-client-version,x-client-type,x-client-session-id,x-client-request-id",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.okou.ai",
      );
      expect(response.headers.get("access-control-allow-methods")).toContain(
        "GET",
      );
      const allowHeaders =
        response.headers.get("access-control-allow-headers") ?? "";
      expect(allowHeaders).toContain("Authorization");
      expect(allowHeaders).toContain("X-Vercel-Protection-Bypass");
      expect(allowHeaders).toContain("X-Client-Version");
      expect(allowHeaders).toContain("X-Client-Type");
      expect(allowHeaders).toContain("X-Client-Session-Id");
      expect(allowHeaders).toContain("X-Client-Request-Id");
    });

    it("answers preview preflight before enforcing the automation bypass", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/api/chat-threads", {
        method: "OPTIONS",
        headers: {
          origin: "https://pr-20640-app.omby.ai",
          "access-control-request-method": "GET",
          "access-control-request-headers":
            "authorization,x-vercel-protection-bypass,x-client-version",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://pr-20640-app.omby.ai",
      );
      const allowHeaders =
        response.headers.get("access-control-allow-headers") ?? "";
      expect(allowHeaders).toContain("Authorization");
      expect(allowHeaders).toContain("X-Vercel-Protection-Bypass");
      expect(allowHeaders).toContain("X-Client-Version");
    });

    it("allows okou preview app origins", async () => {
      mockEnv("ENV", "preview");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://pr-22085-app.omby.ai" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://pr-22085-app.omby.ai",
      );
    });

    it("allows standalone okou app Worker origins in preview", async () => {
      mockEnv("ENV", "preview");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const origin = "https://pr-22085-app-okou-app-preview.vm0.workers.dev";
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    });

    it("does not allow app Worker lookalike origins in preview", async () => {
      mockEnv("ENV", "preview");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      for (const origin of [
        "https://pr-22085-app-okou-app-preview.vm0.workers.dev.evil.example",
        "https://pr-22085-app-okou-app-preview.attacker.workers.dev",
      ]) {
        const response = await app.request("/health", {
          method: "GET",
          headers: { origin },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      }
    });

    it("does not allow lookalike okou preview origins", async () => {
      mockEnv("ENV", "preview");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://pr-22085-app.omby.ai.evil.example" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("rejects disallowed origins by omitting the allow-origin header", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://evil.example.com" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("allows vm7 origins in development", async () => {
      mockEnv("ENV", "development");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://app.vm7.ai:8443" },
      });

      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.vm7.ai:8443",
      );
    });

    it("allows vm7 preview origins on any https port", async () => {
      mockEnv("ENV", "preview");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://www.vm7.ai:3042" },
      });

      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://www.vm7.ai:3042",
      );
    });
  });

  describe("web client compatibility", () => {
    it.each([
      { method: "POST", path: "/api/connectors/github/oauth/start" },
      { method: "PUT", path: "/api/custom-connectors/example/values" },
      { method: "DELETE", path: "/api/connectors/github" },
    ])(
      "force-upgrades singleton-producing App bundles before $method $path route matching",
      async ({ method, path }) => {
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request(path, {
          method,
          headers: {
            [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
            [CLIENT_VERSION_HEADER]: "0.843.0",
          },
        });

        expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
        await expect(response.json()).resolves.toStrictEqual({
          error: "Client update required",
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );

    it("force-upgrades the pre-MCP-reader App before it can read MCP-sourced events", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        headers: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: "0.981.0",
        },
      });

      expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("force-upgrades prereleases below the supported App release", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        headers: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: `${MINIMUM_WEB_CLIENT_VERSION}-rc.1`,
        },
      });

      expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
    });

    it("force-upgrades the previously published App before retired unread route matching", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/api/chat-thread-unreads", {
        method: "GET",
        headers: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: "0.947.0",
        },
      });

      expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it.each(["conversion-preview", "deletion-preview"])(
      "force-upgrades App 0.970.0 before matching the retired %s path",
      async (path) => {
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request(
          `/api/cloudflare-access/configs/00000000-0000-0000-0000-000000000000/${path}`,
          {
            headers: {
              [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
              [CLIENT_VERSION_HEADER]: "0.970.0",
            },
          },
        );

        expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );

    it.each([
      MINIMUM_WEB_CLIENT_VERSION,
      `${MINIMUM_WEB_CLIENT_VERSION}+build.1`,
    ])("allows the canonical web client floor %s", async (version) => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: version,
        },
      });

      expect(response.status).toBe(200);
    });

    it("allows app clients newer than the canonical floor", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: NEWER_WEB_CLIENT_VERSION,
        },
      });

      expect(response.status).toBe(200);
    });

    it.each([CLIENT_TYPE_CLI, CLIENT_TYPE_DESKTOP])(
      "does not force upgrade %s clients",
      async (clientType) => {
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request("/health", {
          headers: {
            [CLIENT_TYPE_HEADER]: clientType,
            [CLIENT_VERSION_HEADER]: "0.599.18",
          },
        });

        expect(response.status).toBe(200);
      },
    );

    it.each([undefined, "development"])(
      "preserves App requests without a parseable version (%s)",
      async (version) => {
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const headers = new Headers({ [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP });
        if (version !== undefined) {
          headers.set(CLIENT_VERSION_HEADER, version);
        }
        const response = await app.request("/health", { headers });

        expect(response.status).toBe(200);
      },
    );

    it("preserves requests without a client type", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: {
          [CLIENT_VERSION_HEADER]: "0.843.0",
        },
      });

      expect(response.status).toBe(200);
    });
  });

  describe("iOS client compatibility", () => {
    const IOS_MINIMUM_VERSION = "0.8.0";

    it.each([
      { method: "GET", path: "/health" },
      { method: "POST", path: "/api/chat-threads" },
    ])(
      "force-upgrades iOS builds below the floor before $method $path route matching",
      async ({ method, path }) => {
        iosClientCompatibility.minimumSupportedVersion = IOS_MINIMUM_VERSION;
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request(path, {
          method,
          headers: {
            [CLIENT_TYPE_HEADER]: CLIENT_TYPE_IOS,
            [CLIENT_VERSION_HEADER]: "0.7.4",
          },
        });

        expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
        await expect(response.json()).resolves.toStrictEqual({
          error: {
            code: "IOS_UPDATE_REQUIRED",
            message: "Update Okou in TestFlight to continue.",
          },
          minimumSupportedVersion: IOS_MINIMUM_VERSION,
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );

    it.each([IOS_MINIMUM_VERSION, "0.8.1", "1.0.0"])(
      "allows iOS %s at or above the floor",
      async (version) => {
        iosClientCompatibility.minimumSupportedVersion = IOS_MINIMUM_VERSION;
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request("/health", {
          headers: {
            [CLIENT_TYPE_HEADER]: CLIENT_TYPE_IOS,
            [CLIENT_VERSION_HEADER]: version,
          },
        });

        expect(response.status).toBe(200);
      },
    );

    it("allows every iOS version while the floor is null", async () => {
      iosClientCompatibility.minimumSupportedVersion = null;
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        headers: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_IOS,
          [CLIENT_VERSION_HEADER]: "0.0.1",
        },
      });

      expect(response.status).toBe(200);
    });

    it.each([undefined, "development", "0.7"])(
      "preserves iOS requests without a parseable version (%s)",
      async (version) => {
        iosClientCompatibility.minimumSupportedVersion = IOS_MINIMUM_VERSION;
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const headers = new Headers({ [CLIENT_TYPE_HEADER]: CLIENT_TYPE_IOS });
        if (version !== undefined) {
          headers.set(CLIENT_VERSION_HEADER, version);
        }
        const response = await app.request("/health", { headers });

        expect(response.status).toBe(200);
      },
    );

    it.each(["ios", "IOS"])(
      "gates only the exact iOS client type, not %s",
      async (clientType) => {
        iosClientCompatibility.minimumSupportedVersion = IOS_MINIMUM_VERSION;
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request("/health", {
          headers: {
            [CLIENT_TYPE_HEADER]: clientType,
            [CLIENT_VERSION_HEADER]: "0.7.4",
          },
        });

        expect(response.status).toBe(200);
      },
    );

    it.each([CLIENT_TYPE_APP, CLIENT_TYPE_DESKTOP])(
      "does not apply the iOS floor to %s clients",
      async (clientType) => {
        iosClientCompatibility.minimumSupportedVersion = "99.0.0";
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request("/health", {
          headers: {
            [CLIENT_TYPE_HEADER]: clientType,
            [CLIENT_VERSION_HEADER]: NEWER_WEB_CLIENT_VERSION,
          },
        });

        expect(response.status).toBe(200);
      },
    );

    it("preserves requests without a client type", async () => {
      iosClientCompatibility.minimumSupportedVersion = IOS_MINIMUM_VERSION;
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        headers: {
          [CLIENT_VERSION_HEADER]: "0.7.4",
        },
      });

      expect(response.status).toBe(200);
    });
  });
});
