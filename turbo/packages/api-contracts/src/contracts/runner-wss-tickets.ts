import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// A 256-bit base64url credential. A run/runner/hostname alone is never a ticket.
const ticketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const runIdSchema = z.uuid("Run ID must be a valid UUID").toLowerCase();
const authorizationSchema = z
  .object({
    runId: runIdSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    orgId: z.string().min(1),
    userId: z.string().min(1),
  })
  .strict();

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
        digest: z.string().regex(/^[0-9a-f]{64}$/),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Atomically redeem a WSS ticket from an official Runner",
  },
  check: {
    method: "POST",
    path: "/api/runners/wss/authorizations/check",
    headers: authHeadersSchema,
    body: z
      .object({
        runnerId: z.uuid().toLowerCase(),
        origin: z.string().max(300),
        authorizations: z.array(authorizationSchema).min(1).max(32),
      })
      .strict(),
    responses: {
      200: z.object({ authorized: z.array(authorizationSchema).max(32) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "Check current Run authority for admitted sessions from an official Runner",
  },
});
