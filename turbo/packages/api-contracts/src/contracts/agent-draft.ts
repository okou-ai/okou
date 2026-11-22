import { array, object, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import {
  persistedAttachmentSchema,
  userMessageInputDocumentSchema,
} from "./chat-threads";
import { requireUserMessageForDraftAttachments } from "./draft-user-message";
import { apiErrorSchema } from "./errors";
import { agentDraftResponseSchema } from "../validators/agent-draft";

export { agentDraftResponseSchema } from "../validators/agent-draft";

const c = initContract();

export const agentDraftRequestSchema = object({
  draftUserMessage: userMessageInputDocumentSchema.nullable(),
  draftAttachments: array(persistedAttachmentSchema).nullable().optional(),
}).superRefine(requireUserMessageForDraftAttachments);

export const composerDraftContract = c.router({
  get: {
    method: "GET",
    path: "/api/chat-drafts/composer",
    headers: authHeadersSchema,
    responses: {
      200: agentDraftResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get the member’s draft for a new chat",
  },
  patch: {
    method: "PATCH",
    path: "/api/chat-drafts/composer",
    headers: authHeadersSchema,
    body: agentDraftRequestSchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update the member’s draft for a new chat",
  },
});

export type AgentDraftResponse = zInfer<typeof agentDraftResponseSchema>;
export type AgentDraftRequest = zInfer<typeof agentDraftRequestSchema>;
