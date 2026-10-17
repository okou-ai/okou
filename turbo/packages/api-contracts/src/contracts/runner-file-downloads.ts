import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { sandboxFsOpenParamsSchema } from "./sandbox-channel-fs";

export const RUNNER_FILE_DOWNLOAD_VERSION = 1;
export const RUNNER_FILE_DOWNLOAD_TTL_SECONDS = 30;
const runIdSchema = z.uuid().toLowerCase();
const ticketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const pathSchema = sandboxFsOpenParamsSchema.shape.path;
const c = initContract();

export const runnerFileDownloadsContract = c.router({
  bootstrap: {
    method: "POST",
    path: "/api/runs/:runId/files/download",
    headers: authHeadersSchema,
    pathParams: z.object({ runId: runIdSchema }),
    body: z.strictObject({ path: pathSchema }),
    responses: {
      200: z.strictObject({
        downloadUrl: z.url(),
        expiresAt: z.iso.datetime(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary:
      "Prepare a one-use native download of one file in an owned live Run",
  },
  consume: {
    method: "POST",
    path: "/api/runners/files/downloads/consume",
    headers: authHeadersSchema,
    body: z.strictObject({
      runId: runIdSchema,
      runnerId: z.uuid().toLowerCase(),
      origin: z.string().max(300),
      ticket: ticketSchema,
    }),
    responses: {
      200: z.strictObject({
        runId: runIdSchema,
        runnerId: z.uuid(),
        orgId: z.string().min(1),
        userId: z.string().min(1),
        origin: z.string(),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        path: pathSchema,
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Redeem an exact-file download grant on its owning official Runner",
  },
});
