import { object, uuid, string, never as zNever } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { chatNormalSendBodyShape, chatEventsContract } from "./chat-event-send";
import {
  projectMessageDocumentSchema,
  projectComposerDraftSchema,
} from "../validators/project-message";
import { apiErrorSchema } from "./errors";
const c = initContract();
export const projectChatContract = c.router({
  agentDraft: {
    method: "GET",
    path: "/api/project-chat/agents/:id/draft",
    pathParams: object({ id: uuid() }),
    headers: authHeadersSchema,
    responses: {
      200: projectComposerDraftSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
  },
  saveAgentDraft: {
    method: "PATCH",
    path: "/api/project-chat/agents/:id/draft",
    pathParams: object({ id: uuid() }),
    headers: authHeadersSchema,
    body: projectComposerDraftSchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
  },
  send: {
    method: "POST",
    path: "/api/project-chat/events",
    headers: authHeadersSchema,
    body: object({
      ...chatNormalSendBodyShape,
      userMessage: projectMessageDocumentSchema,
      clientEventId: uuid().optional(),
      revokesEventId: string().min(1).optional(),
      interruptsRunId: zNever().optional(),
    })
      .strict()
      .refine((b) => {
        return !(b.cloudBrowserEnabled && b.computerUseHostId);
      })
      .refine((b) => {
        return b.userMessage.parts.every((p) => {
          return (
            p.type !== "file" ||
            (p.annotatedFileId === undefined) === (p.annotations === undefined)
          );
        });
      }, "Annotated file and annotations must be supplied together"),
    responses: chatEventsContract.send.responses,
  },
  draft: {
    method: "GET",
    path: "/api/project-chat/:id/draft",
    pathParams: object({ id: uuid() }),
    headers: authHeadersSchema,
    responses: {
      200: projectComposerDraftSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
  },
  saveDraft: {
    method: "PATCH",
    path: "/api/project-chat/:id/draft",
    pathParams: object({ id: uuid() }),
    headers: authHeadersSchema,
    body: projectComposerDraftSchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
  },
});
