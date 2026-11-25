import { iso, object, string, url, uuid, undefined as zUndefined } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

// The opaque ticket is sent only in the first WebSocket text message.
export const runWssTicketSchema = object({
  ticket: string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: iso.datetime(),
}).strict();

const c = initContract();
export const runWssContract = c.router({
  bootstrap: {
    method: "POST",
    path: "/api/runs/:id/wss/bootstrap",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid().toLowerCase() }),
    body: zUndefined(),
    responses: {
      200: runWssTicketSchema.extend({ wssUrl: url({ protocol: /^wss$/ }) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Bootstrap a one-use WebSocket connection to an active Run",
  },
});
