import { z } from "zod";
import { initContract } from "./base";

const c = initContract();

// The MCP SDK owns JSON-RPC validation and JSON/SSE serialization. These are
// registration contracts, not a second HTTP business API.
const responses = {
  200: z.unknown(),
  202: z.unknown(),
  400: z.unknown(),
  401: z.unknown(),
  403: z.unknown(),
  405: z.unknown(),
  406: z.unknown(),
  413: z.unknown(),
  415: z.unknown(),
  500: z.unknown(),
  503: z.unknown(),
};

export const mcpServerContract = c.router({
  request: {
    method: "POST",
    path: "/mcp",
    body: z.unknown(),
    responses,
  },
  get: { method: "GET", path: "/mcp", responses },
  delete: { method: "DELETE", path: "/mcp", responses },
  metadata: {
    method: "GET",
    path: "/.well-known/oauth-protected-resource/mcp",
    responses,
  },
});
