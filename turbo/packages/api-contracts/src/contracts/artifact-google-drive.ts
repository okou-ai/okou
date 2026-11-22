import { literal, object, string, uuid, enum as zEnum } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const artifactGoogleDriveContract = c.router({
  /**
   * Accepts a catalog artifact ID or a specific uploaded file ID. The Chat
   * supplies the Drive account independently of the artifact's source.
   */
  uploadFromChat: {
    method: "POST",
    path: "/api/artifacts/:artifactId/google-drive/chat-uploads",
    headers: authHeadersSchema,
    pathParams: object({ artifactId: uuid() }),
    body: object({
      chatThreadId: uuid(),
      connectionId: uuid().optional(),
      mode: zEnum(["original", "google"]),
    }),
    responses: {
      200: object({
        id: string(),
        name: string(),
        webViewLink: string().nullable(),
        mimeType: string().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema.extend({
        recovery: object({
          action: literal("reconnect"),
          connectionId: uuid(),
        }).optional(),
      }),
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Upload an owned artifact to the current Drive account in a Chat",
  },
});
