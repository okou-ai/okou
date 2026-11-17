import { array, object, string, uuid } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const chatThreadPdfFilenameContract = c.router({
  generate: {
    method: "POST",
    path: "/api/chat-threads/:threadId/pdf-filename",
    headers: authHeadersSchema,
    pathParams: object({ threadId: uuid() }),
    body: object({ eventIds: array(uuid()).min(1).max(100) }).strict(),
    responses: {
      200: string(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Generate a short PDF filename from selected stored messages",
  },
});
