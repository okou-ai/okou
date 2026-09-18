// oxlint-disable-next-line no-restricted-imports -- this file is the api's
// CORS owner and wraps hono's cors helper into a single middleware.
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CLIENT_HEADER_NAMES,
} from "@okouai/api-contracts/contracts/client-headers";

import { safeUrlParse } from "../signals/utils";
import { env } from "./env";
import { allowedMcpOrigin } from "./mcp-server-config";

// Hono owns CORS for registered API routes directly. Their responses need
// CORS headers here because they do not pass through a frontend proxy.
const STATIC_ALLOWED_ORIGINS = Object.freeze(
  new Set(["https://okou.ai", "https://app.vm7.ai:8443"]),
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
    "X-CSRF-Token",
    "X-Requested-With",
    "Accept",
    "Accept-Version",
    "Content-Length",
    "Content-MD5",
    "Content-Type",
    "Date",
    "X-Api-Version",
    "Authorization",
    "Range",
    "X-Vercel-Protection-Bypass",
    ...CLIENT_HEADER_NAMES,
  ],
  exposeHeaders: [CHAT_EVENT_SCHEMA_VERSION_HEADER],
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

export const corsMiddleware: MiddlewareHandler = async (context, next) => {
  if (context.req.path === "/.well-known/oauth-protected-resource/mcp") {
    return mcpMetadataCors(context, next);
  }
  if (context.req.path !== "/mcp") {
    return firstPartyCors(context, next);
  }
  const origin = context.req.header("Origin");
  if (origin !== undefined && !allowedMcpOrigin(origin)) {
    return context.json({ error: "Forbidden Origin" }, 403);
  }
  return await mcpCors(context, next);
};
