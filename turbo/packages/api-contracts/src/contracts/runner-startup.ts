import * as z from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { sandboxStartupPathSchema } from "./runner-primitives";

const c = initContract();

export const runnersRunStartupContract = c.router({
  setStartup: {
    method: "PUT",
    path: "/api/runners/runs/:runId/startup",
    headers: authHeadersSchema,
    pathParams: z.object({ runId: z.uuid() }),
    body: z.object({ sandboxStartupPath: sandboxStartupPathSchema }).strict(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Persist the actual settled sandbox startup path for a Run",
  },
});
