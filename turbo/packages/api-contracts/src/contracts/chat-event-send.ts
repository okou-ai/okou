import {
  boolean,
  object,
  string,
  union,
  uuid,
  never as zNever,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import {
  chatRunOptionsRequestSchema,
  selectedModelRequestSchema,
} from "./chat-run-options";
import { apiErrorSchema } from "./errors";
import {
  chatThreadEventIdSchema,
  userMessageDocumentSchema,
} from "../validators/chat-threads";

const c = initContract();

const chatNormalSendBodyShape = {
  agentId: string().min(1),
  prompt: string().min(1),
  threadId: string().optional(),
  clientThreadId: uuid().optional(),
  chatThreadEventId: chatThreadEventIdSchema.optional(),
  // Client-generated UUID for the sort touch created by direct user sends.
  // Lets event-sourced clients reconcile optimistic sidebar recency by id.
  chatThreadSortEventId: chatThreadEventIdSchema.optional(),
  /**
   * Run whose selected output the user is forwarding. The server resolves the
   * run to authoritative thread and agent provenance before persisting it.
   */
  sourceRunId: uuid().optional(),
  /**
   * Selected model id, or null for Auto. The API resolves the effective
   * provider from org policy and available credentials. Existing threads may
   * omit it to reuse the thread's persisted selection.
   */
  model: selectedModelRequestSchema.nullable().optional(),
  runOptions: chatRunOptionsRequestSchema.optional(),
  userMessage: userMessageDocumentSchema,
  computerUseHostId: uuid().nullable().optional(),
  cloudBrowserEnabled: boolean().optional(),
  hasTextContent: boolean(),
  // Preview evaluation escape hatch: when enabled, the request asks the
  // runner to bypass preview mock CLIs and use the real agent runtime.
  realAgentInPreview: boolean().optional(),
  // Internal diagnostic option: capture bounded request/response data in this
  // run's network logs. Production authorization is enforced at run creation.
  captureNetworkBodies: boolean().optional(),
} as const;

export const chatEventNormalSendBodySchema = object({
  ...chatNormalSendBodyShape,
  // Client-generated UUID used as the user event's primary key.
  clientEventId: uuid().optional(),
  revokesEventId: string().min(1).optional(),
  interruptsRunId: zNever().optional(),
})
  .strict()
  .refine(
    (body) => {
      return !(body.cloudBrowserEnabled && body.computerUseHostId);
    },
    {
      message: "Cloud browser and Computer Use cannot both be enabled",
      path: ["cloudBrowserEnabled"],
    },
  )
  .refine(
    (body) => {
      return body.userMessage.parts.every((part) => {
        return (
          part.type !== "file" ||
          (part.annotatedFileId === undefined) ===
            (part.annotations === undefined)
        );
      });
    },
    {
      message:
        "Annotated user-message files require annotatedFileId and annotations together",
      path: ["userMessage"],
    },
  );

export const chatEventsContract = c.router({
  send: {
    method: "POST",
    path: "/api/chat/events",
    headers: authHeadersSchema,
    body: union([
      chatEventNormalSendBodySchema,
      object({
        agentId: string().min(1),
        threadId: string().min(1),
        revokesEventId: string().min(1),
        clientEventId: uuid().optional(),
        prompt: zNever().optional(),
        clientThreadId: zNever().optional(),
        chatThreadEventId: zNever().optional(),
        chatThreadSortEventId: zNever().optional(),
        sourceRunId: zNever().optional(),
        model: zNever().optional(),
        runOptions: zNever().optional(),
        userMessage: zNever().optional(),
        computerUseHostId: zNever().optional(),
        hasTextContent: zNever().optional(),
        realAgentInPreview: zNever().optional(),
        captureNetworkBodies: zNever().optional(),
        interruptsRunId: zNever().optional(),
      }).strict(),
      object({
        agentId: string().min(1),
        threadId: string().min(1),
        interruptsRunId: uuid().toLowerCase(),
        clientEventId: uuid().optional(),
        prompt: zNever().optional(),
        clientThreadId: zNever().optional(),
        chatThreadEventId: zNever().optional(),
        chatThreadSortEventId: zNever().optional(),
        sourceRunId: zNever().optional(),
        model: zNever().optional(),
        runOptions: zNever().optional(),
        userMessage: zNever().optional(),
        computerUseHostId: zNever().optional(),
        hasTextContent: zNever().optional(),
        realAgentInPreview: zNever().optional(),
        captureNetworkBodies: zNever().optional(),
        revokesEventId: zNever().optional(),
      }).strict(),
    ]),
    responses: {
      /**
       * A send enqueues its input and returns without waiting for a run. The
       * run, or an `input.rejected` event explaining why none started,
       * appears in the thread's event stream.
       */
      201: object({
        threadId: string(),
        createdAt: string().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      422: apiErrorSchema,
      429: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Append a chat event; user input is enqueued and picked into a run asynchronously",
  },
});

export type ChatEventsContract = typeof chatEventsContract;
export type ChatEventSendBody = zInfer<typeof chatEventsContract.send.body>;
