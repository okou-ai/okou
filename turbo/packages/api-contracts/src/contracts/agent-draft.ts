import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import {
  persistedAttachmentSchema,
  userMessageInputDocumentSchema,
  composerDraftSchema,
} from "./chat-threads";
import { requireUserMessageForDraftAttachments } from "./draft-user-message";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const agentDraftResponseSchema = composerDraftSchema;

export const agentDraftRequestSchema = z
  .object({
    draftUserMessage: userMessageInputDocumentSchema.nullable(),
    draftAttachments: z.array(persistedAttachmentSchema).nullable().optional(),
  })
  .superRefine(requireUserMessageForDraftAttachments);

export const agentDraftContract = c.router({
  get: {
    method: "GET",
    path: "/api/agents/:id/draft",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
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
    pathParams: z.object({ id: z.string().uuid() }),
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

export type AgentDraftResponse = z.infer<typeof agentDraftResponseSchema>;
export type AgentDraftRequest = z.infer<typeof agentDraftRequestSchema>;
export type AgentDraftContract = typeof agentDraftContract;
