import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";
import { DATA_ROUTER_PROTOCOL_VERSION } from "@okouai/api-contracts/contracts/data-router-tools";
import { randomUUID } from "node:crypto";

type DataRouterMessage =
  | { method: "tools/list"; params: { cursor?: string } }
  | {
      method: "tools/call";
      params: { name: string; arguments: Record<string, unknown> };
    };

/** One self-contained MCP exchange: no initialize handshake, session or event stream. */
export function fetchDataRouter(
  endpoint: string,
  token: string,
  message: DataRouterMessage,
): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "MCP-Protocol-Version": DATA_ROUTER_PROTOCOL_VERSION,
      "Mcp-Method": message.method,
      ...(message.method === "tools/call"
        ? { "Mcp-Name": message.params.name }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: message.method,
      params: {
        ...message.params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: DATA_ROUTER_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
}
