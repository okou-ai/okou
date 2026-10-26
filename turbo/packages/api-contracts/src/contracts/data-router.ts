import { initContract } from "./base";
import { array, literal, object, string, uuid } from "zod";
import { apiErrorSchema } from "./api-error";

const c = initContract();

/** Raw request-body cap matching the standalone Router's MCP endpoint. */
export const DATA_ROUTER_REQUEST_BODY_MAX_BYTES = 1024 * 1024;

/** MITM registers trusted Run attribution before forwarding a Router tool call. */
export const dataRouterRequestContract = c.router({
  register: {
    method: "POST",
    path: "/api/webhooks/agent/data-request",
    headers: object({ authorization: string().optional() }),
    body: object({ runId: uuid(), requestId: uuid() }).strict(),
    responses: {
      200: object({ success: literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Register a Data Router request for the current Run",
  },
});

/** User-scoped history IDs; Router itself never receives an Okou user identity. */
export const dataRouterHistoryContract = c.router({
  list: {
    method: "GET",
    path: "/api/data/router/requests",
    headers: object({ authorization: string().optional() }),
    responses: {
      200: object({ requestIds: array(uuid()) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List recent Data Router request IDs owned by the current user",
  },
});
