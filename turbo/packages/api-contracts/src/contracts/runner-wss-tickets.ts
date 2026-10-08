import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// A 256-bit base64url credential. A run/runner/hostname alone is never a ticket.
const ticketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const runIdSchema = z.uuid("Run ID must be a valid UUID").toLowerCase();

export const runnerWssTicketsContract = c.router({
  bootstrap: {
    method: "POST",
    path: "/api/runs/:runId/wss/bootstrap",
    headers: authHeadersSchema,
    pathParams: z.object({ runId: runIdSchema }),
    body: z.undefined(),
    responses: {
      200: z.object({
        wssUrl: z.url(),
        ticket: ticketSchema,
        expiresAt: z.iso.datetime(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Bootstrap a one-use WSS connection for an active owned run",
  },
  consume: {
    method: "POST",
    path: "/api/runners/wss/tickets/consume",
    headers: authHeadersSchema,
    body: z
      .object({
        runId: runIdSchema,
        runnerId: z.uuid().toLowerCase(),
        origin: z.string().max(300),
        ticket: ticketSchema,
      })
      .strict(),
    responses: {
      200: z.object({
        runId: runIdSchema,
        runnerId: z.uuid(),
        orgId: z.string(),
        userId: z.string(),
        origin: z.string(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Atomically redeem a WSS ticket from an official Runner",
  },
  revoke: {
    method: "POST",
    path: "/api/runs/:runId/wss/revoke",
    headers: authHeadersSchema,
    pathParams: z.object({ runId: runIdSchema }),
    body: z.undefined(),
    responses: {
      204: z.undefined(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Revoke all outstanding WSS tickets for an owned run",
  },
});
