import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Resource identity is independent of its source chat and run. Accepts a
 * catalog artifact UUID (current projection) or an uploaded artifact's UUID
 * (that exact file), including files intentionally grouped out of the catalog.
 */
export const artifactGoogleDriveContract = c.router({
  upload: {
    method: "POST",
    path: "/api/artifacts/:artifactId/google-drive",
    headers: authHeadersSchema,
    pathParams: z.object({ artifactId: z.uuid() }),
    body: z.object({
      agentId: z.uuid(),
      connectionId: z.uuid().optional(),
    }),
    responses: {
      200: z.object({
        id: z.string(),
        name: z.string(),
        webViewLink: z.string().nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Upload an owned artifact to an authorized Google Drive account",
  },
});
