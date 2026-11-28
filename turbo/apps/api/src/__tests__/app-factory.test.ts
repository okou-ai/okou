import { createHash, randomUUID } from "node:crypto";
import { healthContract } from "@okouai/api-contracts/contracts/health";
import { describe, expect, it } from "vitest";

import { mockEnv } from "../lib/env";
import { createRouteMocks } from "../signals/routes/__tests__/helpers/route-test";
import { chatThreadCreateRoutes } from "../signals/routes/chat-threads-create";
import { healthRoutes } from "../signals/routes/health";
import { vncConnectionsRoutes } from "../signals/routes/vnc-connections";
import { accept, testContext } from "./test-context";
import { setupApp, setupRawAppRequest } from "./test-helpers";

const context = testContext();
const health = setupApp({ context, routes: healthRoutes })(healthContract);

async function checkHealth(headers: Record<string, string>) {
  return await accept(health.check({ extraHeaders: headers }), [200]);
}

function requirePreviewBypass(): string {
  const secret = `bypass-${randomUUID()}`;
  mockEnv("ENV", "preview");
  mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", secret);
  return secret;
}

describe("createApp", () => {
  describe("not found", () => {
    it("app-factory-001 redirects /sign-in?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect to the configured app origin", async () => {
      mockEnv("APP_URL", "https://pr-123-app.vm6.ai");
      const request = setupRawAppRequest({ context, routes: [] });

      const response = await request(
        "https://pr-123-api.vm6.ai/sign-in?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect",
        { method: "GET" },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://pr-123-app.vm6.ai/sign-in?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect",
      );
    });

    it("app-factory-005 returns a 404 JSON response for unmatched routes", async () => {
      createRouteMocks(context).clerk.session(
        `user_${randomUUID()}`,
        `org_${randomUUID()}`,
      );
      const request = setupRawAppRequest({ context, routes: [] });

      const response = await request("/api/legacy/fallthrough?limit=5", {
        method: "GET",
        headers: { authorization: "Bearer clerk-session" },
      });

      expect(response.status).toBe(404);
      expect(response.body).toStrictEqual({ error: "Not found" });
    });
  });

  describe("preview automation bypass", () => {
    it("app-factory-007 rejects preview requests without the Vercel bypass header or cookie", async () => {
      const secret = requirePreviewBypass();
      const request = setupRawAppRequest({ context, routes: healthRoutes });

      const response = await request("/health", { method: "GET" });

      expect(response.status).toBe(403);
      expect(response.body).toStrictEqual({
        error: "Preview automation bypass required",
        debug: {
          expected: createHash("sha256")
            .update(secret)
            .digest("hex")
            .slice(0, 12),
          cookieHeaderPresent: false,
        },
      });
    });

    it("app-factory-013 allows preview requests from https://pr-20640-app.omby.ai with the matching Vercel bypass header", async () => {
      const secret = requirePreviewBypass();
      const origin = "https://pr-20640-app.omby.ai";

      const response = await checkHealth({
        origin,
        "x-vercel-protection-bypass": secret,
      });

      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );
    });
  });

  describe("cors", () => {
    it("app-factory-019 echoes allowed cross-origin on registered route responses", async () => {
      mockEnv("ENV", "production");

      const response = await checkHealth({ origin: "https://app.okou.ai" });

      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.okou.ai",
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );
    });

    it("app-factory-022 allows https origins on okou.ai subdomains", async () => {
      mockEnv("ENV", "production");

      const response = await checkHealth({ origin: "https://console.okou.ai" });

      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://console.okou.ai",
      );
    });

    it("app-factory-023 does not allow lookalike okou.ai origins", async () => {
      mockEnv("ENV", "production");

      const response = await checkHealth({
        origin: "https://app.okou.ai.evil.example",
      });

      expect(response.headers.has("access-control-allow-origin")).toBeFalsy();
    });

    it("app-factory-024 answers preflight without invoking the route handler", async () => {
      mockEnv("ENV", "production");
      const request = setupRawAppRequest({
        context,
        routes: chatThreadCreateRoutes,
      });
      const requestedHeaders = [
        "authorization",
        "x-vercel-protection-bypass",
        "x-client-version",
        "x-client-type",
        "x-client-session-id",
        "x-client-request-id",
      ];

      const response = await request("/api/chat-threads", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.okou.ai",
          "access-control-request-method": "GET",
          "access-control-request-headers": requestedHeaders.join(","),
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.okou.ai",
      );
      expect(
        response.headers.get("access-control-allow-methods")?.split(","),
      ).toContain("GET");
      const allowedHeaders = (
        response.headers.get("access-control-allow-headers") ?? ""
      )
        .toLowerCase()
        .split(",");
      expect(allowedHeaders).toStrictEqual(
        expect.arrayContaining(requestedHeaders),
      );
    });
  });

  describe("web client compatibility", () => {
    it("app-factory-034 force-upgrades App 0.1098.0 before route matching", async () => {
      const request = setupRawAppRequest({
        context,
        routes: vncConnectionsRoutes,
      });

      const response = await request("/api/vnc/connections", {
        method: "GET",
        headers: { "x-client-type": "App", "x-client-version": "0.1098.0" },
      });

      expect(response.status).toBe(426);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.body).toStrictEqual({ error: "Client update required" });
    });

    it("app-factory-039 allows the canonical web client floor 0.1180.0", async () => {
      await expect(
        checkHealth({ "x-client-type": "App", "x-client-version": "0.1180.0" }),
      ).resolves.toMatchObject({ status: 200 });
    });

    it("app-factory-042 does not force upgrade CLI clients", async () => {
      await expect(
        checkHealth({ "x-client-type": "CLI", "x-client-version": "0.599.18" }),
      ).resolves.toMatchObject({ status: 200 });
    });
  });

  describe("iOS client compatibility", () => {
    it("app-factory-047 force-upgrades iOS builds below the floor before GET /health route matching", async () => {
      const request = setupRawAppRequest({ context, routes: healthRoutes });

      const response = await request("/health", {
        method: "GET",
        headers: {
          "x-client-type": "iOS",
          "x-client-version": "0.49.0",
          "x-client-distribution": "testflight",
        },
      });

      expect(response.status).toBe(426);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.body).toStrictEqual({
        error: {
          code: "IOS_UPDATE_REQUIRED",
          message: "Update Okou in TestFlight to continue.",
        },
        minimumSupportedVersion: "0.51.12",
      });
    });
  });
});
