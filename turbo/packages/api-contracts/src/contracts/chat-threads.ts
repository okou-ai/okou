import {
  chatThreadArtifactGoogleDriveRecoverySchema,
  chatThreadArtifactGoogleDriveSyncSchema,
} from "./artifact-google-drive-sync";

import {
  modelSettingsSchema,
  reasoningEffortSchema,
} from "./model-reasoning-effort";
import {
  array,
  boolean,
  coerce,
  discriminatedUnion,
  literal,
  number,
  object,
  record,
  string,
  tuple,
  union,
  url,
  uuid,
  enum as zEnum,
  never as zNever,
  null as zNull,
  undefined as zUndefined,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { chatEventRowSchema } from "./chat-event-rows";
import { CHAT_EVENT_TYPES } from "./chat-events";
import {
  connectorAccountConnectionSchema,
  connectorAccountSelectionSchema,
  connectorAccountTargetSchema,
} from "./connector-accounts";
import { apiErrorSchema } from "./errors";
import { initialRemoteAccessOverrideSchema } from "./chat-remote-access";
import { requireUserMessageForDraftAttachments } from "./draft-user-message";
import { hostedArtifactKindSchema } from "./host";
import { runFailureReasonTokenSchema } from "./run-failure-reasons";
import { runModelIdSchema } from "./model-providers";
import {
  imageAnnotationMarkSchema,
  imageAnnotationSchema,
  persistedAttachmentSchema,
  chatThreadEventIdSchema,
  chatThreadServiceTierSchema,
  chatThreadSnapshotProjectionSchema,
  chatThreadEventSchema,
  presentationGenerationTemplateRequestSchema,
  avatarGenerationOptionsSchema,
  videoGenerationTemplateRequestSchema,
  illustrationGenerationTemplateRequestSchema,
  workflowGenerationTemplateRequestSchema,
  websiteGenerationTemplateRequestSchema,
  generationTemplateRequestSchema,
  feedbackNotePartSchema,
  userMessageInputPartSchema,
  userMessagePartSchema,
  userMessageDocumentSchema,
  userMessageInputDocumentSchema,
  composerDraftSchema,
  type indicatorSchema,
  indicatorsSchema,
} from "../validators/chat-threads";

export {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  annotatedImageFilename,
  chatThreadServiceTierSchema,
  chatThreadSnapshotArchiveSchema,
  chatFollowupsContentDocumentSchema,
  type ChatRecommendedFollowup,
  type ChatFollowupsContentDocument,
  parseChatFollowupsContent,
  resolveChatEventRecommendedFollowups,
  serializeChatFollowupsContent,
  composerDraftSchema,
  indicatorSchema,
  indicatorsSchema,
} from "../validators/chat-threads";

const c = initContract();
const chatThreadDraftSchema = composerDraftSchema;
const chatEventCursorSchema = union([
  object({
    lastEventId: zNull(),
    lastSeqId: literal(0),
  }).strict(),
  object({
    lastEventId: uuid(),
    lastSeqId: number().int().positive(),
  }).strict(),
]);
const chatEventSnapshotResponseBaseSchema = object({
  url: url(),
  expiresInSeconds: number().int().positive(),
});
const chatEventSnapshotResponseSchema = union([
  chatEventSnapshotResponseBaseSchema.extend({
    lastEventId: zNull(),
    lastSeqId: literal(0),
  }),
  chatEventSnapshotResponseBaseSchema.extend({
    lastEventId: uuid(),
    lastSeqId: number().int().positive(),
  }),
]);
const chatEventCatchUpBodySchema = array(
  tuple([uuid(), number().int().nonnegative()]),
);
const chatEventCatchUpResponseSchema = object({
  events: record(uuid(), array(chatEventRowSchema)),
  notFoundThreads: array(uuid()),
});

/** File attachment metadata stored alongside user messages. */
const attachFileSchema = object({
  id: string(),
  filename: string(),
  contentType: string(),
  size: number(),
  annotatedFileId: string().optional(),
  annotations: imageAnnotationSchema.optional(),
});

const assetMaterializationSchema = discriminatedUnion("status", [
  object({ status: literal("ready") }),
  object({ status: literal("pending") }),
  object({
    status: literal("failed"),
    error: object({
      code: string(),
      message: string(),
      retryable: boolean(),
    }),
  }),
]);

const assetRefSchema = object({
  id: uuid(),
  classification: zEnum(["input", "published-output"]),
  access: zEnum(["private", "published"]),
  materialization: assetMaterializationSchema,
  provenance: object({
    provider: string(),
  }).optional(),
});

/**
 * Attach file returned to the frontend with a resolved URL.
 * Legacy attachments expose a public artifact URL. Canonical input assets use
 * an authenticated same-origin URL and identify their durable asset through
 * `assetRef`.
 */
const resolvedAttachFileSchema = attachFileSchema.extend({
  url: string(),
  assetRef: assetRefSchema.optional(),
});

const chatThreadArtifactFileSchema = resolvedAttachFileSchema.extend({
  artifactId: uuid().optional(),
  /** Current catalog display name, independent of the stored filename. */
  title: string().optional(),
  googleDriveConnectionId: uuid().optional(),
  createdAt: string(),
  artifactKind: hostedArtifactKindSchema.optional(),
  previewImageUrl: string().optional(),
  aliasUrl: string().optional(),
  googleDriveSync: chatThreadArtifactGoogleDriveSyncSchema.optional(),
});

const chatThreadArtifactRunSchema = object({
  runId: string(),
  files: array(chatThreadArtifactFileSchema),
});

export { type ReasoningEffort } from "./model-reasoning-effort";

const codexServiceTierSchema = zEnum(["fast"]);

const chatEventUsageProviderBreakdownSchema = object({
  provider: string(),
  credits: number().int().nonnegative(),
});

const chatEventUsageKindBreakdownSchema = object({
  kind: string(),
  credits: number().int().nonnegative(),
  providers: array(chatEventUsageProviderBreakdownSchema),
});

const chatEventUsagePayloadSchema = object({
  version: literal(1),
  totalCredits: number().int().nonnegative(),
  settledAt: string(),
  breakdown: array(chatEventUsageKindBreakdownSchema),
});

const toolSummaryEntrySchema = object({
  kind: literal("tool"),
  name: string(),
  input: record(string(), zUnknown()).optional(),
});

const textSummaryEntrySchema = object({
  kind: literal("text"),
  text: string(),
});

const summaryEntrySchema = union([
  string(),
  toolSummaryEntrySchema,
  textSummaryEntrySchema,
]);

const chatEventBaseSchema = object({
  id: string(),
  threadId: string(),
  content: string().nullable(),
  runId: string().optional(),
  runEventId: string().optional(),
  revokesEventId: string().optional(),
  /** Strictly increasing thread position; it may start above 1 and have gaps. */
  seqId: number().int().positive(),
  sequenceNumber: number().nullable().optional(),
  createdAt: string(),
});

const inputPromptEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("input.prompt"),
    content: zNull(),
    userMessage: userMessageDocumentSchema,
  })
  .strict();

const inputAutomationEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("input.automation"),
    content: zNull(),
    userMessage: userMessageDocumentSchema.optional(),
  })
  .strict();

const inputBudgetEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("input.budget"),
    content: zNull(),
    userMessage: userMessageDocumentSchema,
  })
  .strict();

const inputRejectedEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("input.rejected"),
    content: zNull(),
    userMessage: userMessageDocumentSchema,
    error: string(),
  })
  .strict();

const outputMessageEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("output.message"),
    content: string(),
  })
  .strict();

const outputErrorEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("output.error"),
    error: string(),
  })
  .strict();

const outputFollowupsEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("output.followups"),
    content: string(),
  })
  .strict();

const runCompletedEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("run.completed"),
    runId: string(),
    runLifecycleEvent: literal("completed"),
  })
  .strict();

const runFailedEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("run.failed"),
    runId: string(),
    error: string().optional(),
    failureReason: runFailureReasonTokenSchema.optional(),
    runLifecycleEvent: literal("failed"),
  })
  .strict();

const runCancelledEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("run.cancelled"),
    runId: string(),
    error: string().optional(),
    runLifecycleEvent: literal("cancelled"),
  })
  .strict();

const controlInterruptEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("control.interrupt"),
    content: zNull(),
    interruptsRunId: string(),
  })
  .strict();

const controlRevokeEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("control.revoke"),
    content: zNull(),
    revokesEventId: string(),
  })
  .strict();

const usageRecordedEventSchema = chatEventBaseSchema
  .extend({
    eventType: literal("usage.recorded"),
    runId: string(),
    content: zNull(),
    usage: chatEventUsagePayloadSchema,
  })
  .strict();

/**
 * Redacted public projection of the canonical thread stream.
 * Server-only payload fields are not accepted.
 */
const chatEventSchema = discriminatedUnion("eventType", [
  inputPromptEventSchema,
  inputAutomationEventSchema,
  inputBudgetEventSchema,
  inputRejectedEventSchema,
  outputMessageEventSchema,
  outputErrorEventSchema,
  outputFollowupsEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runCancelledEventSchema,
  controlInterruptEventSchema,
  controlRevokeEventSchema,
  usageRecordedEventSchema,
]);

const projectedChatEventTypes = new Set<string>(
  chatEventSchema.options.map((option) => {
    return option.shape.eventType.value;
  }),
);
if (
  projectedChatEventTypes.size !== CHAT_EVENT_TYPES.length ||
  CHAT_EVENT_TYPES.some((eventType) => {
    return !projectedChatEventTypes.has(eventType);
  })
) {
  throw new Error("ChatEvent schema must cover every event catalog leaf");
}

const chatThreadDetailSchema = object({
  /**
   * Read-state watermark. A thread is unread when its latest run-finish marker
   * is newer than this timestamp.
   */
  lastReadAt: string().nullable(),
  /** A cancelled run is still preserving its resumable session. */
  cancellationRecoveryPending: boolean(),
});

const chatThreadMetadataSchema = object({
  id: string(),
  agentId: uuid(),
  title: string().nullable(),
  selectedModel: string().nullable(),
  modelSettings: modelSettingsSchema,
  /** Legacy pre-GA projection. Ignored by current clients. */
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  serviceTier: chatThreadServiceTierSchema.nullable(),
  pinnedAt: string().nullable(),
  archived: boolean(),
  hidden: boolean().optional(),
  muted: boolean(),
  computerUseHostId: uuid().nullable(),
  cloudBrowserEnabled: boolean(),
});
export type ComposerDraft = zInfer<typeof composerDraftSchema>;

const selectedModelRequestSchema = runModelIdSchema;

const chatThreadCreateBodySchema = object({
  agentId: string().min(1),
  clientThreadId: uuid().optional(),
  eventId: chatThreadEventIdSchema.optional(),
  connectorSelections: array(connectorAccountSelectionSchema).optional(),
  /** Opt in after the client preserves its draft until creation is accepted. */
  connectorSelectionPolicy: literal("required").optional(),
  initialRemoteAccessOverrides: array(initialRemoteAccessOverrideSchema)
    .superRefine((overrides, ctx) => {
      const seen = new Set<string>();
      for (const [index, override] of overrides.entries()) {
        const key = `${override.protocol}:${override.connectionId}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            message: "Duplicate remote access host",
            path: [index],
          });
        }
        seen.add(key);
      }
    })
    .optional(),
  /**
   * Selected model id, or null for Auto. The API resolves the effective model
   * provider from org policy and available credentials. Omit it to store the
   * member default, or Auto when the member preference is unavailable.
   */
  model: selectedModelRequestSchema.nullable().optional(),
  /**
   * Priority service tier for the new thread. Omit it to use the initial model
   * preference, use `priority` to enable it, or null for standard.
   */
  serviceTier: chatThreadServiceTierSchema.nullable().optional(),
  /** Concrete override for the selected model; omission keeps its default. */
  reasoningEffort: reasoningEffortSchema.optional(),
  title: string().optional(),
});

const chatThreadModelSelectionUpdateBodySchema = object({
  /** Selected model id, or null for Auto. */
  model: selectedModelRequestSchema.nullable(),
  /** Omit to keep all model settings; a value patches the selected model. */
  reasoningEffort: reasoningEffortSchema.optional(),
  codexServiceTier: codexServiceTierSchema.nullable().optional(),
  eventId: chatThreadEventIdSchema.optional(),
  serviceTierEventId: chatThreadEventIdSchema.optional(),
});

const chatRunOptionsRequestSchema = object({
  /** Update the selected model's effort. */
  reasoningEffort: reasoningEffortSchema.optional(),
  codexServiceTier: codexServiceTierSchema.optional(),
});

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
  interruptsRunId: zUndefined().optional(),
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

/**
 * Chat thread collection route contract.
 */
export const chatThreadsContract = c.router({
  indicators: {
    method: "GET",
    path: "/api/indicators",
    headers: authHeadersSchema,
    responses: {
      200: indicatorsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "Get active and unread indicators plus unread timestamps for the caller's agents and chat threads in the current organization.",
  },
  snapshot: {
    method: "GET",
    path: "/api/chat-threads/snapshot",
    headers: authHeadersSchema,
    responses: {
      200: union([
        // Every compacted snapshot lives in R2; clients download the
        // archive from this short-lived URL.
        object({
          url: url(),
          expiresInSeconds: number().int().positive(),
          latestEventId: chatThreadEventIdSchema.nullable(),
          latestSeqId: number().int().positive().nullable(),
        }),
        // A scope without a snapshot row returns an empty response.
        object({
          chatThreads: tuple([]),
          latestEventId: zNull(),
          latestSeqId: zNull(),
        }),
      ]),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "Get the compacted chat thread snapshot for the caller's current organization.",
  },
  events: {
    method: "GET",
    path: "/api/chat-threads/events",
    headers: authHeadersSchema,
    query: object({
      sinceSeqId: coerce.number().int().positive().optional(),
    }),
    responses: {
      200: object({
        events: array(chatThreadEventSchema),
        hasMore: boolean(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      410: apiErrorSchema,
    },
    summary: "List chat thread lifecycle events after an optional cursor.",
  },
  create: {
    method: "POST",
    path: "/api/chat-threads",
    headers: authHeadersSchema,
    body: chatThreadCreateBodySchema,
    responses: {
      201: object({
        id: string(),
        title: string().nullable(),
        createdAt: string(),
        /** The model the thread was pinned to; null is Auto. */
        selectedModel: string().nullable(),
        serviceTier: chatThreadServiceTierSchema.nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create a new chat thread",
  },
  drafts: {
    method: "GET",
    // Sibling path (not nested under /chat-threads/) so it can never
    // collide with the /chat-threads/:id route pattern.
    path: "/api/chat-thread-drafts",
    headers: authHeadersSchema,
    query: object({}),
    responses: {
      200: object({
        /**
         * Thread ids owned by the caller that currently hold an unsent draft
         * (a user message with optional `draftAttachments`).
         */
        draftThreadIds: array(string()),
      }),
      401: apiErrorSchema,
    },
    summary:
      "Report which of the caller's chat threads hold an unsent composer draft. Fetched separately from the thread list so the sidebar draft dots don't gate the list query.",
  },
});

/**
 * Chat thread by ID route contract (/api/chat-threads/[id])
 */
const chatThreadIdPathParamsSchema = object({ id: uuid() });
const chatThreadThreadIdPathParamsSchema = object({
  threadId: uuid(),
});

export const CHAT_THREAD_USAGE_RUN_LIMIT = 100;

/** Bounded read: money comes from settled usage, independent of chat hints. */
export const chatThreadUsageContract = c.router({
  read: {
    method: "POST",
    path: "/api/chat-threads/:id/usage",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: object({
      runIds: array(uuid()).min(1).max(CHAT_THREAD_USAGE_RUN_LIMIT),
    }),
    responses: {
      200: object({
        runs: array(
          object({
            runId: uuid(),
            usage: chatEventUsagePayloadSchema,
          }),
        ),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read settled usage for runs owned by a private chat thread",
  },
});

export const chatThreadByIdContract = c.router({
  get: {
    method: "GET",
    path: "/api/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    responses: {
      200: chatThreadDetailSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get private chat thread state",
  },
  patch: {
    method: "PATCH",
    path: "/api/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: object({
      draftUserMessage: userMessageInputDocumentSchema.nullable(),
      draftAttachments: array(persistedAttachmentSchema).nullable().optional(),
    }).superRefine(requireUserMessageForDraftAttachments),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Update chat thread draft message and attachments",
  },
  delete: {
    method: "DELETE",
    path: "/api/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a chat thread",
    body: c.noBody(),
  },
});

/**
 * Thread-scoped composer draft endpoint. Kept separate from thread detail so
 * draft hydration does not require the larger current-thread detail payload.
 */
export const chatThreadDraftContract = c.router({
  get: {
    method: "GET",
    path: "/api/chat-threads/:id/draft",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    responses: {
      200: chatThreadDraftSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Get chat thread draft content and attachments",
  },
});

const chatThreadReadStateResponseSchema = object({
  lastReadAt: string().nullable(),
});

/**
 * Mark a chat thread as read up to its current latest run-finish marker.
 * Separate contract so it can be served by its own route file.
 */
export const chatThreadMarkReadContract = c.router({
  markRead: {
    method: "POST",
    path: "/api/chat-threads/:id/mark-read",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: c.noBody(),
    responses: {
      200: chatThreadReadStateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Mark a chat thread as read up to the latest run-finish marker",
  },
});

/** Mark a chat thread as unread by clearing its read cursor. */
export const chatThreadMarkUnreadContract = c.router({
  markUnread: {
    method: "POST",
    path: "/api/chat-threads/:id/mark-unread",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: c.noBody(),
    responses: {
      200: chatThreadReadStateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Mark a chat thread as unread",
  },
});

/**
 * Mark every unread chat thread under an agent as read.
 * Separate sibling route so it cannot collide with the `:id` thread routes.
 */
export const chatThreadMarkAgentReadContract = c.router({
  markAgentRead: {
    method: "POST",
    path: "/api/chat-thread-unreads/mark-read",
    headers: authHeadersSchema,
    body: object({
      agentId: string().min(1),
    }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Mark all unread chat threads under an agent as read",
  },
});

/**
 * Pin / unpin a chat thread. Two separate POST endpoints (no body) instead
 * of widening `chatThreadByIdContract.patch`, which is intentionally narrow
 * (draft fields only). Mirrors the `mark-read` precedent.
 *
 * Split into two contracts because each lives in its own Next.js route
 * folder; `tsr.router` requires every action in a contract to be handled
 * by the same router file.
 */
export const chatThreadPinContract = c.router({
  pin: {
    method: "POST",
    path: "/api/chat-threads/:id/pin",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: object({
      eventId: chatThreadEventIdSchema.optional(),
      pinOrder: string().min(2).max(2048).optional(),
    }).optional(),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Pin a chat thread to the top of the sidebar",
  },
});

export const chatThreadPinOrderContract = c.router({
  reorder: {
    method: "POST",
    path: "/api/chat-threads/:id/pin-order",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: object({
      pinOrder: string().min(2).max(2048),
      eventId: chatThreadEventIdSchema,
    }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Set a pinned chat thread's order",
  },
});

export const chatThreadUnpinContract = c.router({
  unpin: {
    method: "POST",
    path: "/api/chat-threads/:id/unpin",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Remove the pin from a chat thread",
  },
});

/** Mute changes preserve read cursors, archiving and activity ordering. */
export const chatThreadMuteContract = c.router({
  mute: {
    method: "POST",
    path: "/api/chat-threads/:id/mute",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Mute a chat thread",
  },
  unmute: {
    method: "POST",
    path: "/api/chat-threads/:id/unmute",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Unmute a chat thread",
  },
});

/**
 * Archive / unarchive a chat thread. Both are idempotent: they set the
 * `archived` flag and append the matching thread event without touching the
 * title.
 */
export const chatThreadArchiveContract = c.router({
  archive: {
    method: "POST",
    path: "/api/chat-threads/:id/archive",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Archive a chat thread",
  },
  unarchive: {
    method: "POST",
    path: "/api/chat-threads/:id/unarchive",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Unarchive a chat thread",
  },
});

/**
 * Rename a chat thread POST endpoint. Sets both the title and the
 * `renamed_at` timestamp, which suppresses future automated title
 * generation for this thread.
 *
 * Split into a dedicated contract/route so any POST body widening
 * (e.g. future `{ icon, folder }` fields) stays invisible to the
 * unrelated draft PATCH on chatThreadByIdContract.
 */
export const chatThreadRenameContract = c.router({
  rename: {
    method: "POST",
    path: "/api/chat-threads/:id/rename",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: object({
      title: string().min(1),
      eventId: chatThreadEventIdSchema.optional(),
    }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Rename a chat thread (suppresses automated title generation)",
  },
});

/** Narrow shell metadata for one chat thread; messages remain separate. */
export const chatThreadMetadataContract = c.router({
  get: {
    method: "GET",
    path: "/api/chat-threads/:id/metadata",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    responses: {
      200: chatThreadMetadataSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get chat thread metadata",
  },
});

/**
 * Update a chat thread's model pin. Kept separate from
 * `chatThreadByIdContract.patch`, which intentionally remains draft-only.
 */
export const chatThreadModelSelectionContract = c.router({
  update: {
    method: "POST",
    path: "/api/chat-threads/:id/model-selection",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: chatThreadModelSelectionUpdateBodySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update a chat thread model selection",
  },
});

/** Read, set, or clear sparse per-thread connector account overrides. */
export const chatThreadConnectorSelectionContract = c.router({
  get: {
    method: "GET",
    path: "/api/chat-threads/:id/connector-selections",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    responses: {
      200: object({
        selections: array(connectorAccountSelectionSchema),
        selectedConnections: array(connectorAccountConnectionSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a chat thread's connector account selections",
  },
  update: {
    method: "PUT",
    path: "/api/chat-threads/:id/connector-selections",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: connectorAccountSelectionSchema,
    responses: {
      200: connectorAccountSelectionSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update one chat thread connector account selection",
  },
  clear: {
    method: "DELETE",
    path: "/api/chat-threads/:id/connector-selections",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: connectorAccountTargetSchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Clear one chat thread connector account selection",
  },
});

/**
 * Update a chat thread's Computer Use host binding. Kept separate from
 * `chatThreadByIdContract.patch`, which intentionally remains draft-only.
 */
export const chatThreadComputerUseHostContract = c.router({
  update: {
    method: "POST",
    path: "/api/chat-threads/:id/computer-use-host",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: object({
      computerUseHostId: uuid().nullable(),
      cloudBrowserEnabled: boolean().optional(),
      eventId: chatThreadEventIdSchema.optional(),
    }).refine(
      (body) => {
        return !(body.cloudBrowserEnabled && body.computerUseHostId);
      },
      {
        message: "Cloud browser and Computer Use cannot both be enabled",
        path: ["cloudBrowserEnabled"],
      },
    ),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update a chat thread Computer Use host binding",
  },
});

/** Canonical ChatEvent write contract. */
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
        prompt: zUndefined().optional(),
        clientThreadId: zUndefined().optional(),
        chatThreadEventId: zUndefined().optional(),
        chatThreadSortEventId: zUndefined().optional(),
        sourceRunId: zUndefined().optional(),
        model: zUndefined().optional(),
        runOptions: zUndefined().optional(),
        userMessage: zUndefined().optional(),
        computerUseHostId: zUndefined().optional(),
        hasTextContent: zUndefined().optional(),
        realAgentInPreview: zUndefined().optional(),
        captureNetworkBodies: zUndefined().optional(),
        interruptsRunId: zUndefined().optional(),
      }).strict(),
      object({
        agentId: string().min(1),
        threadId: string().min(1),
        interruptsRunId: uuid().toLowerCase(),
        clientEventId: uuid().optional(),
        prompt: zUndefined().optional(),
        clientThreadId: zUndefined().optional(),
        chatThreadEventId: zUndefined().optional(),
        chatThreadSortEventId: zUndefined().optional(),
        sourceRunId: zUndefined().optional(),
        model: zUndefined().optional(),
        runOptions: zUndefined().optional(),
        userMessage: zUndefined().optional(),
        computerUseHostId: zUndefined().optional(),
        hasTextContent: zUndefined().optional(),
        realAgentInPreview: zUndefined().optional(),
        captureNetworkBodies: zUndefined().optional(),
        revokesEventId: zUndefined().optional(),
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

/**
 * Single chat message in a search result.
 * `(chatThreadId, seqId)` is the stable identity and `runId` carries optional
 * run ownership.
 */
const chatSearchMessageSchema = object({
  chatThreadId: string(),
  role: zEnum(["user", "assistant"]),
  content: string(),
  createdAt: string(),
  seqId: number().int().positive(),
  runId: string().nullable(),
});

const chatSearchMatchRangeSchema = object({
  /** UTF-16 code-unit offset, compatible with JavaScript String.slice. */
  start: number().int().nonnegative(),
  /** Exclusive UTF-16 code-unit offset. */
  end: number().int().positive(),
});

const chatSearchResultSchema = object({
  chatThreadId: string(),
  agentName: string(),
  matchedMessage: chatSearchMessageSchema,
  matchedRanges: array(chatSearchMatchRangeSchema),
});

export const CHAT_SEARCH_RESULT_LIMIT = 100;

/** Up to 100 newest messages within an unordered set of 500 keyword matches. No pagination or full-history newest guarantee. */
const chatSearchResponseSchema = object({
  results: array(chatSearchResultSchema).max(CHAT_SEARCH_RESULT_LIMIT),
});

/**
 * Chat search contract (GET /api/chat/search)
 * Searches chat messages within the caller's own threads in the caller's org.
 * Authorization is enforced at the DB query level via userId + orgId filters.
 *
 * The search index is updated asynchronously. Recent messages can be available
 * in event history before search, including after their Run completes. Empty
 * results do not prove absence. The response provides no index freshness signal
 * or lag bound; candidate/result limits do not imply a complete or current view.
 *
 * Confirm recent sends using the known thread's chatThreadEventsContract
 * snapshot and rows operations. Read the snapshot when present, then follow
 * raw-row pages using their paired sequence/event cursor while hasMore is true.
 * On 410, rebuild from a fresh snapshot. Do not resend solely because search
 * returns no matches.
 */
export const chatSearchContract = c.router({
  search: {
    method: "GET",
    path: "/api/chat/search",
    headers: authHeadersSchema,
    query: object({
      keyword: string().trim().min(1),
      agentId: uuid().optional(),
      since: coerce.number().optional(),
    }),
    responses: {
      200: chatSearchResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Search up to 100 messages from 500 scoped keyword candidates",
  },
});

/** Canonical ChatEvent read contract. */
export const chatThreadEventsContract = c.router({
  /**
   * Batch tail read for the SharedWorker cache. Every requested thread is
   * returned exactly once: either as a complete raw-row tail (including an
   * empty tail) or in `notFoundThreads` when the supplied cursor cannot be
   * continued and the client must rebuild from a Snapshot.
   */
  catchUp: {
    method: "POST",
    path: "/api/chat/events/catch-up",
    headers: authHeadersSchema,
    body: chatEventCatchUpBodySchema,
    responses: {
      200: chatEventCatchUpResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      426: apiErrorSchema,
    },
    summary: "Catch up raw chat events for multiple threads",
  },
  /**
   * Snapshot-read cold start: a presigned download for the thread's head
   * archive object. The object is gzip NDJSON of chatEventRowSchema lines
   * stored with `Content-Encoding: gzip`, so a browser fetch decompresses it
   * transparently.
   */
  snapshot: {
    method: "GET",
    path: "/api/chat-threads/:threadId/event-snapshot",
    headers: authHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    responses: {
      200: chatEventSnapshotResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      426: apiErrorSchema,
    },
    summary: "Get a presigned download for the thread's chat event snapshot",
  },
  /**
   * Raw-row tail after a snapshot or cached cursor. `sinceSeqId: 0` reads a
   * thread from the beginning, which is the cold start for a thread the
   * archiver has not reached yet. 410 signals that the cursor row no longer
   * exists and the client must rebuild from a fresh snapshot.
   */
  rows: {
    method: "GET",
    path: "/api/chat-threads/:threadId/event-rows",
    headers: authHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    query: union([
      object({
        sinceSeqId: coerce.number().pipe(literal(0)),
        sinceEventId: zNever().optional(),
        limit: coerce.number().min(1).max(50).default(50),
      }),
      object({
        sinceSeqId: coerce.number().int().positive(),
        sinceEventId: uuid(),
        limit: coerce.number().min(1).max(50).default(50),
      }),
    ]),
    responses: {
      200: object({
        rows: array(chatEventRowSchema),
        cursor: chatEventCursorSchema,
        hasMore: boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      410: apiErrorSchema,
      426: apiErrorSchema,
    },
    summary: "Get raw chat event rows after a seq cursor",
  },
});

export const chatThreadArtifactsContract = c.router({
  list: {
    method: "GET",
    path: "/api/chat-threads/:threadId/artifacts",
    headers: authHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    responses: {
      200: object({
        runs: array(chatThreadArtifactRunSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List a chat thread's uploaded files grouped by source run",
  },
});

export type ChatThreadsContract = typeof chatThreadsContract;
export type ChatThreadByIdContract = typeof chatThreadByIdContract;
export type ChatThreadDraftContract = typeof chatThreadDraftContract;
export type ChatThreadMarkReadContract = typeof chatThreadMarkReadContract;
export type ChatThreadMarkUnreadContract = typeof chatThreadMarkUnreadContract;
export type ChatThreadMarkAgentReadContract =
  typeof chatThreadMarkAgentReadContract;
export type ChatThreadPinContract = typeof chatThreadPinContract;
export type ChatThreadPinOrderContract = typeof chatThreadPinOrderContract;
export type ChatThreadUnpinContract = typeof chatThreadUnpinContract;
export type ChatThreadRenameContract = typeof chatThreadRenameContract;
export type ChatThreadMetadataContract = typeof chatThreadMetadataContract;
export type ChatThreadModelSelectionContract =
  typeof chatThreadModelSelectionContract;
export type ChatThreadConnectorSelectionContract =
  typeof chatThreadConnectorSelectionContract;
export type ChatThreadComputerUseHostContract =
  typeof chatThreadComputerUseHostContract;
export type ChatEventsContract = typeof chatEventsContract;
export type ChatThreadEventsContract = typeof chatThreadEventsContract;
export type ChatThreadArtifactsContract = typeof chatThreadArtifactsContract;
export type ChatSearchContract = typeof chatSearchContract;
export type ChatSearchResponse = zInfer<typeof chatSearchResponseSchema>;
export type ChatSearchResult = zInfer<typeof chatSearchResultSchema>;
export type ChatSearchMessage = zInfer<typeof chatSearchMessageSchema>;

export {
  chatThreadSnapshotProjectionSchema,
  chatThreadEventSchema,
  chatThreadDetailSchema,
  chatThreadMetadataSchema,
  chatThreadDraftSchema,
  chatRunOptionsRequestSchema,
  generationTemplateRequestSchema,
  userMessageInputPartSchema,
  userMessageInputDocumentSchema,
  userMessagePartSchema,
  userMessageDocumentSchema,
  presentationGenerationTemplateRequestSchema,
  videoGenerationTemplateRequestSchema,
  illustrationGenerationTemplateRequestSchema,
  websiteGenerationTemplateRequestSchema,
  chatEventSchema,
  chatEventUsagePayloadSchema,
  summaryEntrySchema,
  persistedAttachmentSchema,
  attachFileSchema,
  resolvedAttachFileSchema,
  imageAnnotationSchema,
  imageAnnotationMarkSchema,
  chatThreadArtifactFileSchema,
  chatThreadArtifactGoogleDriveRecoverySchema,
  chatThreadArtifactGoogleDriveSyncSchema,
  chatThreadArtifactRunSchema,
};

export type CodexServiceTier = zInfer<typeof codexServiceTierSchema>;
export type ChatThreadServiceTier = zInfer<typeof chatThreadServiceTierSchema>;
export type ChatRunOptionsRequest = zInfer<typeof chatRunOptionsRequestSchema>;
export type GenerationTemplateRequest = zInfer<
  typeof generationTemplateRequestSchema
>;
export type GenerationTemplateType = GenerationTemplateRequest["type"];
export type FeedbackNotePart = zInfer<typeof feedbackNotePartSchema>;
export type UserMessageInputPart = zInfer<typeof userMessageInputPartSchema>;
export type UserMessageInputDocument = zInfer<
  typeof userMessageInputDocumentSchema
>;
export type UserMessagePart = zInfer<typeof userMessagePartSchema>;
export type UserMessageDocument = zInfer<typeof userMessageDocumentSchema>;
export type LegacyThreadGenerationTemplateType = Exclude<
  GenerationTemplateType,
  "workflow" | "website"
>;
/**
 * Legacy generation template shape retained for older thread-level storage.
 * Current prompt injection uses the generation template attached to the current
 * message only.
 */
export type ThreadGenerationTemplates = Partial<
  Record<
    LegacyThreadGenerationTemplateType,
    Extract<
      GenerationTemplateRequest,
      { type: LegacyThreadGenerationTemplateType }
    >
  >
>;
export type PresentationGenerationTemplateRequest = zInfer<
  typeof presentationGenerationTemplateRequestSchema
>;
export type AvatarGenerationOptions = zInfer<
  typeof avatarGenerationOptionsSchema
>;
export type VideoGenerationTemplateRequest = zInfer<
  typeof videoGenerationTemplateRequestSchema
>;
export type IllustrationGenerationTemplateRequest = zInfer<
  typeof illustrationGenerationTemplateRequestSchema
>;
export type WorkflowGenerationTemplateRequest = zInfer<
  typeof workflowGenerationTemplateRequestSchema
>;
export type WebsiteGenerationTemplateRequest = zInfer<
  typeof websiteGenerationTemplateRequestSchema
>;

export type SummaryEntry = zInfer<typeof summaryEntrySchema>;
export type ChatThreadSnapshotProjection = zInfer<
  typeof chatThreadSnapshotProjectionSchema
>;
export type ChatThreadEvent = zInfer<typeof chatThreadEventSchema>;
export type ChatThreadDetail = zInfer<typeof chatThreadDetailSchema>;
export type ChatThreadMetadata = zInfer<typeof chatThreadMetadataSchema>;
export type ChatThreadDraft = zInfer<typeof chatThreadDraftSchema>;
export type ChatEvent = zInfer<typeof chatEventSchema>;
export type ChatEventSendBody = zInfer<typeof chatEventsContract.send.body>;
export type Indicator = zInfer<typeof indicatorSchema>;
export type Indicators = zInfer<typeof indicatorsSchema>;

export function chatEventResponse(event: ChatEvent): ChatEvent {
  return chatEventSchema.parse(event);
}

export type ChatInputEvent = Extract<
  ChatEvent,
  {
    eventType:
      "input.prompt" | "input.automation" | "input.budget" | "input.rejected";
  }
>;
export type ChatUserMessageEvent = Extract<
  ChatEvent,
  { eventType: "input.prompt" | "input.budget" | "input.rejected" }
>;
export type ChatAutomationEvent = Extract<
  ChatEvent,
  { eventType: "input.automation" }
>;
export type ChatPromptEvent = Extract<ChatEvent, { eventType: "input.prompt" }>;
export type ChatFollowupsEvent = Extract<
  ChatEvent,
  { eventType: "output.followups" }
>;
export type ChatUsageEvent = Extract<
  ChatEvent,
  { eventType: "usage.recorded" }
>;
export type ChatEventUsagePayload = zInfer<typeof chatEventUsagePayloadSchema>;
export type PersistedAttachment = zInfer<typeof persistedAttachmentSchema>;
export type ImageAnnotation = zInfer<typeof imageAnnotationSchema>;
export type ImageAnnotationMark = zInfer<typeof imageAnnotationMarkSchema>;
export type ImageAnnotationMarkShape = ImageAnnotationMark["shape"];
export type AttachFile = zInfer<typeof attachFileSchema>;
export type AssetRef = zInfer<typeof assetRefSchema>;
export type ResolvedAttachFile = zInfer<typeof resolvedAttachFileSchema>;
export type ChatThreadArtifactFile = zInfer<
  typeof chatThreadArtifactFileSchema
>;
export type { ChatThreadArtifactGoogleDriveSync } from "./artifact-google-drive-sync";
export type { ChatThreadArtifactGoogleDriveRecovery } from "./artifact-google-drive-sync";
export type ChatThreadArtifactRun = zInfer<typeof chatThreadArtifactRunSchema>;
