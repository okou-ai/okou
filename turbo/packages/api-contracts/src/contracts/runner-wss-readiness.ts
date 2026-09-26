import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const pathParams = z.object({ runnerId: z.uuid() }).strict();
const proof = z
  .object({
    // Returned by the protected local Unix listener in response to the probe.
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  409: apiErrorSchema,
  503: apiErrorSchema,
};

/** Host-only contract; this is NOT a Web bootstrap or public endpoint. */
export const runnerWssReadinessContract = c.router({
  renew: {
    method: "PUT",
    path: "/api/runners/wss-readiness/:runnerId",
    pathParams,
    headers: authHeadersSchema,
    body: z.object({ proof }).strict(),
    responses: {
      200: z
        .object({ leaseExpiresAt: z.string().datetime({ offset: true }) })
        .strict(),
      ...errors,
    },
    summary: "Record locally probed WSS listener readiness from a bound host",
  },
  status: {
    method: "GET",
    path: "/api/runners/wss-readiness/:runnerId",
    pathParams,
    headers: authHeadersSchema,
    responses: {
      200: z
        .object({
          localReady: z.boolean(),
          publicIngressReady: z.literal(false),
        })
        .strict(),
      401: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Read the caller host's local listener readiness",
  },
  withdraw: {
    method: "DELETE",
    path: "/api/runners/wss-readiness/:runnerId",
    pathParams,
    headers: authHeadersSchema,
    // Conditional on the lease issued to this registrar. A stale DELETE must
    // not erase readiness from a newer successful probe on the same host.
    body: z
      .object({ leaseExpiresAt: z.string().datetime({ offset: true }) })
      .strict(),
    responses: {
      200: z.object({ ok: z.literal(true) }).strict(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Withdraw the caller host's local listener readiness",
  },
});
