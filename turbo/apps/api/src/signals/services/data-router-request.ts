import {
  dataRouterRequest,
  type DataRouterMessage,
} from "@okouai/api-contracts/contracts/data-router-tools";
import { randomUUID } from "node:crypto";

/** One self-contained MCP exchange: no initialize handshake, session or event stream. */
export function fetchDataRouter(
  endpoint: string,
  token: string,
  message: DataRouterMessage,
): Promise<Response> {
  const request = dataRouterRequest(message, randomUUID());
  return fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...request.headers },
    body: request.body,
  });
}
