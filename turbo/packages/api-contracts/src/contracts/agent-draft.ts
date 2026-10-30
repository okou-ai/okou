import { array, object, string, type infer as zInfer } from "zod";

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

export const agentDraftContract = c.router({
  get: {
    method: "GET",
    path: "/api/agents/:id/draft",
    headers: authHeadersSchema,
    pathParams: object({ id: string().uuid() }),
    responses: {
      200: agentDraftResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent draft",
  },
  patch: {
    method: "PATCH",
    path: "/api/agents/:id/draft",
    headers: authHeadersSchema,
    pathParams: object({ id: string().uuid() }),
    body: agentDraftRequestSchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update agent draft",
  },
});

export type AgentDraftResponse = zInfer<typeof agentDraftResponseSchema>;
export type AgentDraftRequest = zInfer<typeof agentDraftRequestSchema>;
export type AgentDraftContract = typeof agentDraftContract;
