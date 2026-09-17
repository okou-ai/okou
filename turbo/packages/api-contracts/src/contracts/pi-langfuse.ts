import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const PI_LANGFUSE_RELAY_MAX_BYTES = 4 * 1024 * 1024;

/** Opaque OTLP/HTTP payloads; only the API owns the Langfuse destination/auth. */
export const piLangfuseTracesContract = c.router({
  export: {
    method: "POST",
    path: "/api/webhooks/agent/:runId/langfuse/traces",
    pathParams: z.object({ runId: z.uuid() }),
    headers: authHeadersSchema,
    body: c.type<ArrayBuffer | string>(),
    responses: {
      200: c.type<unknown>(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      415: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Export an admitted Pi run's OTLP traces through platform Langfuse",
  },
});
