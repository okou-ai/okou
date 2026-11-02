import { number, object } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const cronCleanupXResourceReadsContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/cleanup-x-resource-reads",
    headers: authHeadersSchema,
    responses: {
      200: object({ deleted: number().int().nonnegative() }),
      401: apiErrorSchema,
    },
    summary: "Delete X resource reads older than yesterday in UTC",
  },
});
export type CronCleanupXResourceReadsContract =
  typeof cronCleanupXResourceReadsContract;
