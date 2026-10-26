import { unknown as zUnknown } from "zod";
import { initContract } from "./base";

const c = initContract();

// The MCP SDK owns JSON-RPC validation and JSON/SSE serialization. These are
// registration contracts, not a second HTTP business API.
const responses = {
  200: zUnknown(),
  202: zUnknown(),
  400: zUnknown(),
  401: zUnknown(),
  403: zUnknown(),
  405: zUnknown(),
  406: zUnknown(),
  413: zUnknown(),
  415: zUnknown(),
  500: zUnknown(),
  503: zUnknown(),
};

export const mcpServerContract = c.router({
  request: {
    method: "POST",
    path: "/mcp",
    body: zUnknown(),
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
