import { object, string, uuid, enum as zEnum } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Resource identity is independent of its source chat and run. Accepts a
 * catalog artifact UUID (current projection) or an uploaded artifact's UUID
 * (that exact file), including files intentionally grouped out of the catalog.
 */
const uploadBody = object({
  agentId: uuid(),
  connectionId: uuid().optional(),
});
const uploadRoute = {
  method: "POST",
  headers: authHeadersSchema,
  pathParams: object({ artifactId: uuid() }),
  responses: {
    200: object({
      id: string(),
      name: string(),
      webViewLink: string().nullable(),
      mimeType: string().optional(),
    }),
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    503: apiErrorSchema,
  },
} as const;

export const artifactGoogleDriveContract = c.router({
  /** Cached clients retain the historical Slides auto-conversion behavior. */
  upload: {
    ...uploadRoute,
    path: "/api/artifacts/:artifactId/google-drive",
    body: uploadBody,
    summary: "Upload an owned artifact to an authorized Google Drive account",
  },
  // A distinct path makes an older API reject the request before creating a
  // file, instead of silently ignoring mode and changing the user's intent.
  uploadWithMode: {
    ...uploadRoute,
    path: "/api/artifacts/:artifactId/google-drive/uploads",
    body: uploadBody.extend({ mode: zEnum(["original", "google"]) }),
    summary:
      "Upload an original artifact or convert it to a Google editor format",
  },
});
