// oxlint-disable-next-line no-restricted-imports -- this file is the api's
// CORS owner and wraps hono's cors helper into a single middleware.
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { CLIENT_HEADER_NAMES } from "@okouai/api-contracts/contracts/client-headers";

import { safeUrlParse } from "../signals/utils";
import { env } from "./env";
import { allowedMcpOrigin } from "./mcp-server-config";

// Hono owns CORS for registered API routes directly. Their responses need
// CORS headers here because they do not pass through a frontend proxy.
const STATIC_ALLOWED_ORIGINS = Object.freeze(
  new Set(["https://okou.ai", "https://www.vm0.ai", "https://app.vm7.ai:8443"]),
);
const OKOU_APP_WORKER_PREVIEW_HOST_PATTERN =
  /^(?:staging|pr-[0-9]+)-app-okou-app-preview\.vm0\.workers\.dev$/u;

export function isOkouAppWorkerPreviewHostname(hostname: string): boolean {
  return OKOU_APP_WORKER_PREVIEW_HOST_PATTERN.test(hostname.toLowerCase());
}

export function allowedCorsOrigin(origin: string | undefined): string | null {
  if (!origin) {
    return null;
  }

  const url = safeUrlParse(origin);
  if (!url) {
    return null;
  }

  const normalizedOrigin = url.origin;
  const { hostname, protocol } = url;

  if (STATIC_ALLOWED_ORIGINS.has(normalizedOrigin)) {
    return normalizedOrigin;
  }

  const deployEnv = env("ENV");

  const allowHttpLocalhost =
    deployEnv === "development" &&
    protocol === "http:" &&
    hostname === "localhost";
  if (!allowHttpLocalhost && protocol !== "https:") {
    return null;
  }

  if (hostname.endsWith(".okou.ai")) {
    return normalizedOrigin;
  }

  if (
    deployEnv === "preview" &&
    (hostname.endsWith(".vm7.ai") ||
      hostname.endsWith(".omby.ai") ||
      (url.port === "" && isOkouAppWorkerPreviewHostname(hostname)))
  ) {
    return normalizedOrigin;
  }

  if (deployEnv === "development") {
    if (hostname === "localhost") {
      return normalizedOrigin;
    }
    if (hostname.endsWith(".vm6.ai")) {
      return normalizedOrigin;
    }
    if (hostname.endsWith(".vm7.ai")) {
      return normalizedOrigin;
    }
  }

  return null;
}

const firstPartyCors: MiddlewareHandler = cors({
  origin: (origin) => {
    return allowedCorsOrigin(origin);
  },
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowHeaders: [
    "Accept",
    "Content-Length",
    "Content-MD5",
    "Content-Type",
    "Date",
    "Authorization",
    "Range",
    "X-Vercel-Protection-Bypass",
    ...CLIENT_HEADER_NAMES,
  ],
  maxAge: 86_400,
});

const mcpCors = cors({
  origin: (origin) => {
    return allowedMcpOrigin(origin) ? origin : null;
  },
  allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Authorization",
    "Content-Type",
    "Accept",
    "MCP-Protocol-Version",
    "MCP-Method",
    "MCP-Name",
    "Mcp-Session-Id",
    "Last-Event-ID",
  ],
  exposeHeaders: ["WWW-Authenticate", "MCP-Protocol-Version", "Mcp-Session-Id"],
  maxAge: 600,
});
const mcpMetadataCors = cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] });

function isG2ChatRequest(method: string, path: string): boolean {
  if (method === "POST") {
    return (
      path === "/api/chat-threads" ||
      path === "/api/chat/events" ||
      path === "/api/realtime/token"
    );
  }
  return (
    method === "GET" &&
    /^\/api\/chat-threads\/[\dA-Fa-f]{8}(?:-[\dA-Fa-f]{4}){3}-[\dA-Fa-f]{12}\/(?:metadata|event-snapshot|event-rows)$/u.test(
      path,
    )
  );
}

export const corsMiddleware: MiddlewareHandler = async (context, next) => {
  const { req } = context;
  if (req.path === "/.well-known/oauth-protected-resource/mcp") {
    return mcpMetadataCors(context, next);
  }
  const origin = req.header("Origin");
  if (req.path === "/mcp") {
    if (origin !== undefined && !allowedMcpOrigin(origin)) {
      return context.json({ error: "Forbidden Origin" }, 403);
    }
    return mcpCors(context, next);
  }

  // Even Hub serves the installed G2 package on a loopback port chosen at launch.
  if (
    origin?.startsWith("http://127.0.0.1:") &&
    safeUrlParse(origin)?.origin === origin
  ) {
    const preflight = req.method === "OPTIONS";
    const method = preflight
      ? (req.header("Access-Control-Request-Method") ?? "")
      : req.method;
    if (isG2ChatRequest(method, req.path)) {
      const hasAuthorization = preflight
        ? req
            .header("Access-Control-Request-Headers")
            ?.toLowerCase()
            .split(",")
            .some((name) => {
              return name.trim() === "authorization";
            })
        : /^Bearer \S+$/u.test(req.header("Authorization") ?? "");
      if (!hasAuthorization || req.header("Cookie") !== undefined) {
        return context.json({ error: "Bearer authentication required" }, 403);
      }
      return cors({
        origin,
        allowMethods: [method],
        allowHeaders: ["Authorization", "Content-Type"],
        maxAge: 600,
      })(context, next);
    }
  }
  return await firstPartyCors(context, next);
};
