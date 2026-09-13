import {
  modelSettingsPatchSchema,
  modelSettingsSchema,
  reasoningEffortSchema,
} from "./model-reasoning-effort";
import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { chatEventRowSchema } from "./chat-event-rows";
import { CHAT_EVENT_SCHEMA_VERSION_HEADER } from "./chat-event-schema-version";
import { CHAT_EVENT_TYPES } from "./chat-events";
import {
  connectorAccountConnectionSchema,
  connectorAccountSelectionSchema,
  connectorAccountTargetSchema,
} from "./connector-accounts";
import { apiErrorSchema } from "./errors";
import { imageModelIdSchema } from "./image-models";
import { requireUserMessageForDraftAttachments } from "./draft-user-message";
import { hostedArtifactKindSchema } from "./host";
import { introVideoOptionsSchema } from "./intro-video-options";
import { runFailureReasonTokenSchema } from "./run-failure-reasons";
import { runStatusSchema } from "./runs";
import { supportedRunModelSchema } from "./model-providers";
import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  videoModelIdSchema,
} from "./video-models";
import {
  avatarVideoAspectRatioSchema,
  avatarVideoVoiceIdSchema,
} from "./avatar-video";

const c = initContract();
const chatEventReadHeadersSchema = authHeadersSchema.extend({
  [CHAT_EVENT_SCHEMA_VERSION_HEADER]: z.string(),
});
const chatEventCursorSchema = z.union([
  z
    .object({
      lastEventId: z.null(),
      lastSeqId: z.literal(0),
    })
    .strict(),
  z
    .object({
      lastEventId: z.string().uuid(),
      lastSeqId: z.number().int().positive(),
    })
    .strict(),
]);
const chatEventSnapshotResponseBaseSchema = z.object({
  url: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
});
const chatEventSnapshotResponseSchema = z.union([
  chatEventSnapshotResponseBaseSchema.extend({
    lastEventId: z.null(),
    lastSeqId: z.literal(0),
  }),
  chatEventSnapshotResponseBaseSchema.extend({
    lastEventId: z.string().uuid(),
    lastSeqId: z.number().int().positive(),
  }),
]);
const chatEventCatchUpBodySchema = z.array(
  z.tuple([z.string().uuid(), z.number().int().nonnegative()]),
);
const chatEventCatchUpResponseSchema = z.object({
  events: z.record(z.string().uuid(), z.array(chatEventRowSchema)),
  notFoundThreads: z.array(z.string().uuid()),
});
export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

const annotationPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const annotationRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/**
 * Ink is stored as a literal hex rather than a palette enum: the palette is a
 * design decision that will move, and an enum would turn every future palette
 * edit into a read migration for annotations already sitting in the database.
 * The client picks from `ANNOTATION_INKS`; this boundary only rejects garbage.
 */
const annotationInkSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/**
 * One mark drawn on an attached image.
 *
 * Geometry is normalized to the image's own 0..1 space, never pixels, so a mark
 * survives every rescale it passes through — the 36px composer chip, the editor
 * canvas at whatever zoom, and the flatten that renders at the image's native
 * resolution. `note` is the sentence the user attached to that mark; it is what
 * reaches the agent as text, separately from the pixels.
 *
 * `ordinal` is the number drawn on the mark and quoted back to the agent. It is
 * stored rather than derived from position because deleting a mark must not
 * renumber the ones the user has already talked about; the freed number is
 * handed to the next new mark instead. Absent on marks saved before this.
 */
const markOrdinalSchema = z.number().int().positive().optional();

const imageAnnotationMarkSchema = z.discriminatedUnion("shape", [
  z.object({
    id: z.string(),
    ordinal: markOrdinalSchema,
    shape: z.literal("box"),
    rect: annotationRectSchema,
    ink: annotationInkSchema,
    note: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    ordinal: markOrdinalSchema,
    shape: z.literal("arrow"),
    from: annotationPointSchema,
    to: annotationPointSchema,
    ink: annotationInkSchema,
    note: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    ordinal: markOrdinalSchema,
    shape: z.literal("pen"),
    points: z.array(annotationPointSchema),
    ink: annotationInkSchema,
    note: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    ordinal: markOrdinalSchema,
    shape: z.literal("text"),
    at: annotationPointSchema,
    text: z.string(),
    ink: annotationInkSchema,
    /**
     * Type size as a multiple of the base label size, set by dragging a corner
     * of the label. Absent means 1: a mark placed before the handles existed,
     * or one nobody resized.
     */
    scale: z.number().min(0.5).max(4).optional(),
  }),
  // Highlight and redact carry no ink: a highlight is always the one yellow
  // wash, and a redaction is an opaque neutral block — colouring either would
  // make it read as a mark instead of as a state of the image.
  z.object({
    id: z.string(),
    ordinal: markOrdinalSchema,
    shape: z.literal("highlight"),
    rect: annotationRectSchema,
    note: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    ordinal: markOrdinalSchema,
    shape: z.literal("redact"),
    rect: annotationRectSchema,
  }),
]);

const imageAnnotationSchema = z.object({
  marks: z.array(imageAnnotationMarkSchema),
  /** Normalized crop applied before the marks are drawn. */
  crop: annotationRectSchema.optional(),
});

/**
 * Filename the rendered derivative is uploaded under, derived from the
 * original so the pair reads together in any list that shows both.
 *
 * This lives on the contract because the app writes the name and the API
 * reads it back as the artifact lookup hint. Two independently deployed copies
 * would drift silently: the exact-key lookup would miss and degrade into a
 * prefix listing while the agent prompt showed a name no artifact has.
 */
export function annotatedImageFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem}.annotated.png`;
}

/** File attachment metadata stored alongside user messages. */
const attachFileSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  annotatedFileId: z.string().optional(),
  annotations: imageAnnotationSchema.optional(),
});

const assetMaterializationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }),
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("failed"),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    }),
  }),
]);

const assetRefSchema = z.object({
  id: z.string().uuid(),
  classification: z.enum(["input", "published-output"]),
  access: z.enum(["private", "published"]),
  materialization: assetMaterializationSchema,
  provenance: z
    .object({
      provider: z.string(),
    })
    .optional(),
});

/**
 * Attach file returned to the frontend with a resolved URL.
 * Legacy attachments expose a public artifact URL. Canonical input assets use
 * an authenticated same-origin URL and identify their durable asset through
 * `assetRef`.
 */
const resolvedAttachFileSchema = attachFileSchema.extend({
  url: z.string(),
  assetRef: assetRefSchema.optional(),
});

const chatThreadArtifactGoogleDriveRecoverySchema = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("authorize") }),
    z.object({ action: z.literal("connect") }),
    z.object({
      action: z.literal("reconnect"),
      connectionId: z.uuid(),
    }),
    z.object({ action: z.literal("unavailable") }),
  ],
);

const chatThreadArtifactGoogleDriveAccountReadyShape = {
  /**
   * Emitted after the thread account, credentials, and agent authorization
   * resolve. The disconnected variant carries no readiness marker.
   */
  accountReady: z.literal(true),
};

const chatThreadArtifactGoogleDriveSyncSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("synced"),
    ...chatThreadArtifactGoogleDriveAccountReadyShape,
    id: z.string(),
    name: z.string(),
    webViewLink: z.string().nullable(),
  }),
  z.object({
    status: z.literal("not_synced"),
    ...chatThreadArtifactGoogleDriveAccountReadyShape,
  }),
  z.object({
    status: z.literal("disconnected"),
    recovery: chatThreadArtifactGoogleDriveRecoverySchema.optional(),
  }),
  z.object({
    status: z.literal("unknown"),
    ...chatThreadArtifactGoogleDriveAccountReadyShape,
  }),
]);

const chatThreadArtifactFileSchema = resolvedAttachFileSchema.extend({
  createdAt: z.string(),
  artifactKind: hostedArtifactKindSchema.optional(),
  previewImageUrl: z.string().optional(),
  aliasUrl: z.string().optional(),
  googleDriveSync: chatThreadArtifactGoogleDriveSyncSchema.optional(),
});

const chatThreadArtifactRunSchema = z.object({
  runId: z.string(),
  files: z.array(chatThreadArtifactFileSchema),
});

/**
 * Attachment metadata persisted in chat_threads.draft_attachments.
 *
 * `url` is the public artifact CDN URL.
 * Historically this stored a 7-day presigned URL that could silently expire
 * while drafts sat in the DB; the public artifact URL removes that footgun.
 */
const persistedAttachmentSchema = z.object({
  id: z.string(),
  url: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
});

/**
 * Per-agent unread snapshot. `unreadAt` is the creation time of the latest
 * run-finish marker — the one that made the thread unread.
 */
const chatThreadUnreadsSchema = z.object({
  unreads: z.array(
    z.object({
      threadId: z.string(),
      unreadAt: z.string(),
    }),
  ),
});

export const indicatorSchema = z.enum(["active", "unread"]);

const indicatorsSchema = z.object({
  agents: z.record(z.string().uuid(), indicatorSchema),
  threads: z.record(z.string().uuid(), indicatorSchema),
});

const chatThreadEventIdSchema = z.string().uuid();
export { type ReasoningEffort } from "./model-reasoning-effort";

const codexServiceTierSchema = z.enum(["fast"]);
export const chatThreadServiceTierSchema = z.enum(["priority"]);

const chatThreadSnapshotProjectionSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  title: z.string().nullable(),
  sortAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pinnedAt: z.string().nullable(),
  // Optional for existing snapshots and browser caches without manual ordering.
  pinOrder: z.string().nullable().optional(),
  renamedAt: z.string().nullable(),
  selectedModel: z.string().nullable().default(null),
  modelSettings: modelSettingsSchema.optional(),
  /** Legacy pre-GA projection. Ignored by current clients. */
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  serviceTier: chatThreadServiceTierSchema.nullable().default(null),
  computerUseHostId: z.string().uuid().nullable().default(null),
  cloudBrowserEnabled: z.boolean().optional(),
  // Loose rather than the catalog enum so a pin whose model later leaves the
  // catalog still parses; the strict enum applies on the write path.
  selectedVideoModel: z.string().nullable(),
  // Keep this optional for pre-field browser rows and loose rather than
  // imageModelIdSchema so a stored model that later leaves the catalog remains
  // replayable. New write contracts validate against the shared schema.
  // Follow-up: https://github.com/vm0-ai/vm0/issues/27688
  selectedImageModel: z.string().nullable().optional(),
});

const chatThreadEventSchema = z.object({
  id: chatThreadEventIdSchema,
  /** Server-assigned strict position within the user/org event stream. */
  seqId: z.number().int().positive(),
  kind: z.enum([
    "created",
    "renamed",
    "deleted",
    "pinned",
    "unpinned",
    "model_selection_updated",
    "service_tier_updated",
    "computer_use_host_updated",
    "video_model_updated",
    "image_model_updated",
    "sort_touched",
  ]),
  chatThreadId: z.string().uuid(),
  agentId: z.string().uuid(),
  title: z.string().nullable(),
  // On sort_touched, this changes pin rank instead of activity recency.
  pinOrder: z.string().nullable().optional(),
  selectedModel: z.string().nullable().default(null),
  /** Full map is present on created events. */
  modelSettings: modelSettingsSchema.optional(),
  /** Later updates change at most one model entry. */
  modelSettingsPatch: modelSettingsPatchSchema.optional(),
  /** Legacy pre-GA projection. Ignored by current clients. */
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  serviceTier: chatThreadServiceTierSchema.nullable().default(null),
  computerUseHostId: z.string().uuid().nullable().default(null),
  cloudBrowserEnabled: z.boolean().optional(),
  selectedVideoModel: z.string().nullable(),
  selectedImageModel: z.string().nullable().optional(),
  createdAt: z.string(),
});

const chatEventUsageProviderBreakdownSchema = z.object({
  provider: z.string(),
  credits: z.number().int().nonnegative(),
});

const chatEventUsageKindBreakdownSchema = z.object({
  kind: z.string(),
  credits: z.number().int().nonnegative(),
  providers: z.array(chatEventUsageProviderBreakdownSchema),
});

const chatEventUsagePayloadSchema = z.object({
  version: z.literal(1),
  totalCredits: z.number().int().nonnegative(),
  settledAt: z.string(),
  breakdown: z.array(chatEventUsageKindBreakdownSchema),
});

const toolSummaryEntrySchema = z.object({
  kind: z.literal("tool"),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const textSummaryEntrySchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
});

const summaryEntrySchema = z.union([
  z.string(),
  toolSummaryEntrySchema,
  textSummaryEntrySchema,
]);

const presentationGenerationTemplateRequestSchema = z.object({
  type: z.literal("presentation"),
  selection: z
    .object({
      templateId: z.string().min(1),
      colorSystemId: z.string().min(1).optional(),
      previewUrl: z.string().url().optional(),
    })
    .strict(),
});

/**
 * Talking-avatar parameters. Unrelated to text-to-video despite sharing the
 * "video" envelope, which older bundles rely on to parse newer messages.
 */
const avatarGenerationOptionsSchema = z
  .object({
    titleSnapshot: z.string().trim().min(1),
    previewUrl: z.url(),
    voiceId: avatarVideoVoiceIdSchema,
    aspectRatio: avatarVideoAspectRatioSchema,
  })
  .partial();

const videoGenerationTemplateRequestSchema = z.object({
  type: z.literal("video"),
  selection: z.object({
    stylePresetId: z.string().min(1),
    avatarOptions: avatarGenerationOptionsSchema.optional(),
    // Keep the video envelope readable by previously deployed clients.
    /** Intro Video selections; the key predates the product name and is persisted with the message. */
    explainerOptions: introVideoOptionsSchema.optional(),

    /**
     * The four fields below are no longer written: the web-client floor has
     * been raised past the app version that introduced avatarOptions, so no
     * live reader predates the nested object. They stay parseable because rows
     * persisted before the split only carry the flat shape, and
     * readAvatarTemplateOptions still reads them. Dropping them here would
     * strip those historical selections on parse; they can only go away with a
     * jsonb backfill. Tracked in https://github.com/vm0-ai/vm0/issues/25620.
     *
     * @deprecated Read-only fallback; write avatarOptions.titleSnapshot.
     */
    titleSnapshot: z.string().trim().min(1).optional(),
    /** @deprecated Read-only fallback; write avatarOptions.previewUrl. */
    previewUrl: z.url().optional(),
    /** @deprecated Read-only fallback; write avatarOptions.voiceId. */
    voiceId: avatarVideoVoiceIdSchema.optional(),
    /** @deprecated Read-only fallback; write avatarOptions.aspectRatio. */
    aspectRatio: avatarVideoAspectRatioSchema.optional(),
  }),
});

const illustrationGenerationTemplateRequestSchema = z.object({
  type: z.literal("illustration"),
  selection: z.object({
    illustrationStyleId: z.string().min(1),
  }),
});

const workflowGenerationTemplateRequestSchema = z.object({
  type: z.literal("workflow"),
  selection: z.object({
    workflowTemplateId: z.string().min(1),
  }),
});

const websiteGenerationTemplateRequestSchema = z.object({
  type: z.literal("website"),
  selection: z
    .object({
      websiteTemplateId: z.string().min(1),
    })
    .strict(),
});

const generationTemplateRequestSchema = z.discriminatedUnion("type", [
  presentationGenerationTemplateRequestSchema,
  videoGenerationTemplateRequestSchema,
  illustrationGenerationTemplateRequestSchema,
  workflowGenerationTemplateRequestSchema,
  websiteGenerationTemplateRequestSchema,
]);

const userMessageTextPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1),
  })
  .strict();

const userMessageChatThreadPartSchema = z
  .object({
    type: z.literal("chat_thread"),
    threadId: z.string().uuid(),
    titleSnapshot: z.string().min(1),
  })
  .strict();

const userMessageAgentPartSchema = z
  .object({
    type: z.literal("agent"),
    agentId: z.string().uuid(),
    nameSnapshot: z.string().min(1),
  })
  .strict();

const userMessageTemplatePartSchema = z
  .object({
    type: z.literal("template"),
    titleSnapshot: z.string().min(1),
    template: generationTemplateRequestSchema,
  })
  .strict();

const feedbackNotePartSchema = z.discriminatedUnion("type", [
  userMessageTextPartSchema,
  userMessageChatThreadPartSchema,
  userMessageAgentPartSchema,
  userMessageTemplatePartSchema,
]);

const feedbackRangeSchema = z
  .object({
    /** UTF-16 code-unit offset, compatible with JavaScript String.slice. */
    start: z.number().int().nonnegative(),
    /** Exclusive UTF-16 code-unit offset. */
    end: z.number().int().positive(),
  })
  .strict()
  .refine(
    (range) => {
      return range.end > range.start;
    },
    { path: ["end"], message: "Feedback range end must be after start" },
  );

const userMessageExternalSourcePartSchema = z
  .object({
    type: z.literal("source"),
    kind: z.enum([
      "slack",
      "feishu",
      "teams",
      "telegram",
      "github",
      "agentphone",
    ]),
    href: z.string().url().optional(),
  })
  .strict();

const userMessageAgentSourcePartSchema = z
  .object({
    type: z.literal("source"),
    kind: z.literal("agent"),
    runId: z.string().uuid(),
    threadId: z.string().uuid(),
    agentId: z.string().uuid(),
    titleSnapshot: z.string().min(1),
    href: z.string().min(1),
  })
  .strict();

const userMessageSourcePartSchema = z.discriminatedUnion("kind", [
  userMessageExternalSourcePartSchema,
  userMessageAgentSourcePartSchema,
]);

const userMessageInputPartSchema = z.discriminatedUnion("type", [
  userMessageTextPartSchema,
  userMessageChatThreadPartSchema,
  userMessageAgentPartSchema,
  userMessageTemplatePartSchema,
  userMessageSourcePartSchema,
  z
    .object({
      /** Client-authored context included in agent prompts, not visible text. */
      type: z.literal("additional_info"),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("automation"),
      workflowName: z.string().min(1),
      workflowId: z.string().uuid().optional(),
      automationBrief: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("goal"),
      goalBrief: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("file"),
      fileId: z.string().min(1),
      filenameSnapshot: z.string().min(1),
      contentType: z.string().min(1),
      /** Rendered derivative produced from the original file and annotations. */
      annotatedFileId: z.string().min(1).optional(),
      /** Editable marks sufficient to reconstruct the confirmed result. */
      annotations: imageAnnotationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("feedback"),
      quote: z.string().min(1),
      note: z.array(feedbackNotePartSchema),
      eventId: z.string().min(1).optional(),
      range: feedbackRangeSchema.optional(),
      source: z
        .object({
          type: z.literal("mail"),
          id: z.string().min(1),
          status: z.enum(["draft", "sent"]),
          sentId: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .refine(
      (feedback) => {
        return (
          (feedback.eventId === undefined) === (feedback.range === undefined)
        );
      },
      {
        message: "Feedback eventId and range must be provided together",
      },
    ),
]);

const userMessageModelPartSchema = z
  .object({
    type: z.literal("model"),
    selectedModel: z.string().min(1),
    serviceTier: chatThreadServiceTierSchema.optional(),
  })
  .strict();

const userMessagePartSchema = z.discriminatedUnion("type", [
  ...userMessageInputPartSchema.options,
  userMessageModelPartSchema,
]);

const userMessageDocumentSchema = z
  .object({
    version: z.literal(1),
    parts: z
      .array(userMessagePartSchema)
      .min(1)
      .refine(
        (parts) => {
          return (
            parts.filter((part) => {
              return (
                part.type === "source" ||
                part.type === "automation" ||
                part.type === "goal"
              );
            }).length <= 1
          );
        },
        { message: "A user message may contain at most one non-content part" },
      )
      .refine(
        (parts) => {
          return (
            parts.filter((part) => {
              return part.type === "model";
            }).length <= 1
          );
        },
        { message: "A user message may contain at most one model part" },
      ),
  })
  .strict();

const userMessageInputDocumentSchema = z
  .object({
    version: z.literal(1),
    parts: z
      .array(userMessageInputPartSchema)
      .min(1)
      .refine(
        (parts) => {
          return (
            parts.filter((part) => {
              return (
                part.type === "source" ||
                part.type === "automation" ||
                part.type === "goal"
              );
            }).length <= 1
          );
        },
        { message: "A user message may contain at most one non-content part" },
      ),
  })
  .strict();

const chatEventBaseSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  content: z.string().nullable(),
  runId: z.string().optional(),
  runGroupId: z.string().optional(),
  runEventId: z.string().optional(),
  revokesEventId: z.string().optional(),
  /** Strictly increasing thread position; it may start above 1 and have gaps. */
  seqId: z.number().int().positive(),
  sequenceNumber: z.number().nullable().optional(),
  createdAt: z.string(),
});

const chatEventRecommendedFollowupShape = {
  prompt: z.string(),
  kind: z.enum(["talk", "generate"]),
  generationType: z
    .enum(["image", "video", "presentation", "website"])
    .optional(),
};

export const chatFollowupsContentDocumentSchema = z
  .object({
    version: z.literal(1),
    followups: z.array(z.object(chatEventRecommendedFollowupShape).strict()),
  })
  .strict();

export type ChatRecommendedFollowup = z.infer<
  typeof chatFollowupsContentDocumentSchema
>["followups"][number];
export type ChatFollowupsContentDocument = z.infer<
  typeof chatFollowupsContentDocumentSchema
>;

export function parseChatFollowupsContent(
  content: string | null,
): ChatFollowupsContentDocument | null {
  if (content === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    const result = chatFollowupsContentDocumentSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function resolveChatEventRecommendedFollowups(event: {
  readonly content: string | null;
}): readonly ChatRecommendedFollowup[] {
  const content = parseChatFollowupsContent(event.content);
  return content?.followups ?? [];
}

export function serializeChatFollowupsContent(
  followups: readonly ChatRecommendedFollowup[],
): string {
  const content: ChatFollowupsContentDocument = {
    version: 1,
    followups: [...followups],
  };
  return JSON.stringify(chatFollowupsContentDocumentSchema.parse(content));
}

const inputPromptEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("input.prompt"),
    content: z.null(),
    userMessage: userMessageDocumentSchema,
  })
  .strict();

const inputAutomationEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("input.automation"),
    content: z.null(),
    userMessage: userMessageDocumentSchema.optional(),
  })
  .strict();

const inputGoalEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("input.goal"),
    content: z.null(),
    userMessage: userMessageDocumentSchema,
    // Queue association stays server-side; the public event preserves only
    // the user-facing document and stream ordering contract.
    runId: z.never().optional(),
    runGroupId: z.never().optional(),
    runEventId: z.never().optional(),
    revokesEventId: z.never().optional(),
    sequenceNumber: z.never().optional(),
  })
  .strict();

const inputBudgetEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("input.budget"),
    content: z.null(),
    userMessage: userMessageDocumentSchema,
  })
  .strict();

const inputRejectedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("input.rejected"),
    content: z.null(),
    userMessage: userMessageDocumentSchema,
    error: z.string(),
  })
  .strict();

const outputMessageEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("output.message"),
    content: z.string(),
  })
  .strict();

const outputErrorEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("output.error"),
    error: z.string(),
  })
  .strict();

const outputThinkingEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("output.thinking"),
    content: z.null(),
    thinking: z.string(),
  })
  .strict();

const outputFollowupsEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("output.followups"),
    content: z.string(),
  })
  .strict();

const runQueuedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("run.queued"),
    runId: z.string(),
    content: z.string(),
  })
  .strict();

const runDequeuedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("run.dequeued"),
    runId: z.string(),
    content: z.null(),
    revokesEventId: z.string(),
  })
  .strict();

const runCompletedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("run.completed"),
    runId: z.string(),
    runLifecycleEvent: z.literal("completed"),
  })
  .strict();

const runFailedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("run.failed"),
    runId: z.string(),
    error: z.string().optional(),
    failureReason: runFailureReasonTokenSchema.optional(),
    runLifecycleEvent: z.literal("failed"),
  })
  .strict();

const runCancelledEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("run.cancelled"),
    runId: z.string(),
    error: z.string().optional(),
    runLifecycleEvent: z.literal("cancelled"),
  })
  .strict();

const controlInterruptEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("control.interrupt"),
    content: z.null(),
    interruptsRunId: z.string(),
  })
  .strict();

const controlRevokeEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("control.revoke"),
    content: z.null(),
    revokesEventId: z.string(),
  })
  .strict();

const browserOpenEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("browser.open"),
    content: z.null(),
  })
  .strict();

const browserCloseEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("browser.close"),
    content: z.null(),
  })
  .strict();

const goalMarkerMetadataSchema = {
  runId: z.never().optional(),
  runGroupId: z.never().optional(),
  runEventId: z.never().optional(),
  revokesEventId: z.never().optional(),
  sequenceNumber: z.never().optional(),
};

const goalOpenEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("goal.open"),
    content: z
      .string()
      .min(1)
      .refine((content) => {
        return content === content.trim();
      }, "Goal title must be trimmed"),
    ...goalMarkerMetadataSchema,
  })
  .strict();

const goalCloseEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("goal.close"),
    content: z.null(),
    ...goalMarkerMetadataSchema,
  })
  .strict();

const usageRecordedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("usage.recorded"),
    runId: z.string(),
    content: z.null(),
    usage: chatEventUsagePayloadSchema,
  })
  .strict();

/**
 * Redacted public projection of the canonical thread stream.
 * Server-only payload fields are not accepted.
 */
const chatEventSchema = z.discriminatedUnion("eventType", [
  inputPromptEventSchema,
  inputAutomationEventSchema,
  inputGoalEventSchema,
  inputBudgetEventSchema,
  inputRejectedEventSchema,
  outputMessageEventSchema,
  outputErrorEventSchema,
  outputThinkingEventSchema,
  outputFollowupsEventSchema,
  runQueuedEventSchema,
  runDequeuedEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runCancelledEventSchema,
  controlInterruptEventSchema,
  controlRevokeEventSchema,
  browserOpenEventSchema,
  browserCloseEventSchema,
  goalOpenEventSchema,
  goalCloseEventSchema,
  usageRecordedEventSchema,
]);

if (CHAT_EVENT_TYPES.length !== chatEventSchema.options.length) {
  throw new Error(
    "ChatEvent schema must cover every registered event catalog leaf",
  );
}

const chatThreadDetailSchema = z.object({
  /**
   * Read-state watermark. A thread is unread when its latest run-finish marker
   * is newer than this timestamp.
   */
  lastReadAt: z.string().nullable(),
  /** A cancelled run is still preserving its resumable session. */
  cancellationRecoveryPending: z.boolean(),
});

const chatThreadMetadataSchema = z.object({
  id: z.string(),
  agentId: z.string().uuid(),
  title: z.string().nullable(),
  selectedModel: z.string().nullable(),
  modelSettings: modelSettingsSchema,
  /** Legacy pre-GA projection. Ignored by current clients. */
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  serviceTier: chatThreadServiceTierSchema.nullable(),
  pinnedAt: z.string().nullable(),
  computerUseHostId: z.string().uuid().nullable(),
  cloudBrowserEnabled: z.boolean(),
  selectedVideoModel: z.string().nullable(),
  selectedImageModel: z.string().nullable(),
});

const chatThreadDraftSchema = z
  .object({
    draftUserMessage: userMessageInputDocumentSchema.nullable(),
    draftAttachments: z.array(persistedAttachmentSchema).nullable(),
  })
  .superRefine(requireUserMessageForDraftAttachments);

const selectedModelRequestSchema = supportedRunModelSchema;

const chatThreadCreateBodySchema = z.object({
  agentId: z.string().min(1),
  clientThreadId: z.string().uuid().optional(),
  eventId: chatThreadEventIdSchema.optional(),
  connectorSelections: z.array(connectorAccountSelectionSchema).optional(),
  /**
   * Selected model id. The API resolves the effective model provider from org
   * policy and available credentials. Omit it to inherit the model of the run
   * that owns the calling token; callers without a run must send it.
   */
  model: selectedModelRequestSchema.optional(),
  /**
   * Priority service tier for the new thread. Omit it to inherit the calling
   * run's chat thread, use `priority` to enable it, or null for standard.
   */
  serviceTier: chatThreadServiceTierSchema.nullable().optional(),
  /**
   * Video model for the new thread. Omit it to inherit the calling run's chat
   * thread video model.
   */
  videoModel: videoModelIdSchema.optional(),
  /**
   * Image model for the new thread. Omit it to inherit the calling run's chat
   * thread image model.
   */
  imageModel: imageModelIdSchema.optional(),
  /** Concrete override for the selected model; omission keeps its default. */
  reasoningEffort: reasoningEffortSchema.optional(),
  title: z.string().optional(),
});

const chatThreadVideoModelUpdateBodySchema = z.object({
  /** Video model id, or null to fall back to the member and system defaults. */
  model: videoModelIdSchema.nullable(),
  eventId: chatThreadEventIdSchema.optional(),
});

const chatThreadImageModelUpdateBodySchema = z.object({
  /** Image model id, or null to fall back to the member and system defaults. */
  model: imageModelIdSchema.nullable(),
  eventId: chatThreadEventIdSchema.optional(),
});

const chatThreadModelSelectionUpdateBodySchema = z.object({
  /**
   * Selected model id, or null to clear the thread's selected model.
   */
  model: selectedModelRequestSchema.nullable(),
  /** Omit to keep all model settings; a value patches the selected model. */
  reasoningEffort: reasoningEffortSchema.optional(),
  codexServiceTier: codexServiceTierSchema.nullable().optional(),
  eventId: chatThreadEventIdSchema.optional(),
  serviceTierEventId: chatThreadEventIdSchema.optional(),
});

/**
 * Text-to-video parameters chosen for this send only.
 *
 * Deliberately not persisted as structured settings: the API renders them into
 * the run's agent prompt, so a reload starts from the effective model's
 * defaults again. The model itself is absent because it is already resolved
 * from the thread pin and the member default the run carries.
 */
const chatRunVideoOptionsRequestSchema = z
  .object({
    aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
    duration: z.enum(VIDEO_DURATIONS),
    resolution: z.enum(VIDEO_RESOLUTIONS),
    generateAudio: z.boolean(),
  })
  .partial();

const chatRunOptionsRequestSchema = z.object({
  /** Update the selected model's effort. */
  reasoningEffort: reasoningEffortSchema.optional(),
  codexServiceTier: codexServiceTierSchema.optional(),
  video: chatRunVideoOptionsRequestSchema.optional(),
});

const chatNormalSendBodyShape = {
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  threadId: z.string().optional(),
  clientThreadId: z.string().uuid().optional(),
  chatThreadEventId: chatThreadEventIdSchema.optional(),
  // Client-generated UUID for the sort touch created by direct user sends.
  // Lets event-sourced clients reconcile optimistic sidebar recency by id.
  chatThreadSortEventId: chatThreadEventIdSchema.optional(),
  /**
   * Run whose selected output the user is forwarding. The server resolves the
   * run to authoritative thread and agent provenance before persisting it.
   */
  sourceRunId: z.string().uuid().optional(),
  /**
   * Selected model id. The API resolves the effective provider from org
   * policy and available credentials. Existing threads may omit it to
   * reuse the thread's persisted model.
   */
  model: selectedModelRequestSchema.optional(),
  runOptions: chatRunOptionsRequestSchema.optional(),
  userMessage: userMessageDocumentSchema.refine((message) => {
    return message.parts.every((part) => {
      return part.type !== "goal";
    });
  }, "Goal input is no longer supported"),
  computerUseHostId: z.string().uuid().nullable().optional(),
  cloudBrowserEnabled: z.boolean().optional(),
  hasTextContent: z.boolean(),
  // Preview evaluation escape hatch: when enabled, the request asks the
  // runner to bypass preview mock CLIs and use the real agent runtime.
  realAgentInPreview: z.boolean().optional(),
  // Internal diagnostic option: capture bounded request/response data in this
  // run's network logs. Production authorization is enforced at run creation.
  captureNetworkBodies: z.boolean().optional(),
} as const;

const chatEventNormalSendBodySchema = z
  .object({
    ...chatNormalSendBodyShape,
    // Client-generated UUID used as the user event's primary key.
    clientEventId: z.string().uuid().optional(),
    revokesEventId: z.string().min(1).optional(),
    interruptsRunId: z.undefined().optional(),
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
    },
    summary:
      "Get active and unread indicators for the caller's agents and chat threads in the current organization.",
  },
  snapshot: {
    method: "GET",
    path: "/api/chat-threads/snapshot",
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        chatThreads: z.array(chatThreadSnapshotProjectionSchema),
        latestEventId: chatThreadEventIdSchema.nullable(),
        latestSeqId: z.number().int().positive().nullable(),
      }),
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
    query: z.object({
      sinceSeqId: z.coerce.number().int().positive().optional(),
    }),
    responses: {
      200: z.object({
        events: z.array(chatThreadEventSchema),
        hasMore: z.boolean(),
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
      201: z.object({
        id: z.string(),
        title: z.string().nullable(),
        createdAt: z.string(),
        /** The model the thread was pinned to. */
        selectedModel: z.string(),
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
    query: z.object({}),
    responses: {
      200: z.object({
        /**
         * Thread ids owned by the caller that currently hold an unsent draft
         * (a user message with optional `draftAttachments`).
         */
        draftThreadIds: z.array(z.string()),
      }),
      401: apiErrorSchema,
    },
    summary:
      "Report which of the caller's chat threads hold an unsent composer draft. Fetched separately from the thread list so the sidebar draft dots don't gate the list query.",
  },
  unreads: {
    method: "GET",
    path: "/api/chat-thread-unreads",
    headers: authHeadersSchema,
    query: z.object({
      agentId: z.string().min(1),
    }),
    responses: {
      200: chatThreadUnreadsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "List the caller's unread chat threads under an agent, each with the timestamp of the message that made it unread.",
  },
});

/**
 * Chat thread by ID route contract (/api/chat-threads/[id])
 */
const chatThreadIdPathParamsSchema = z.object({ id: z.string().uuid() });
const chatThreadThreadIdPathParamsSchema = z.object({
  threadId: z.string().uuid(),
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
    body: z
      .object({
        draftUserMessage: userMessageInputDocumentSchema.nullable(),
        draftAttachments: z
          .array(persistedAttachmentSchema)
          .nullable()
          .optional(),
      })
      .superRefine(requireUserMessageForDraftAttachments),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update chat thread draft message and attachments",
  },
  delete: {
    method: "DELETE",
    path: "/api/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: z.object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
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
      404: apiErrorSchema,
    },
    summary: "Get chat thread draft content and attachments",
  },
});

const chatThreadReadStateResponseSchema = z.object({
  lastReadAt: z.string().nullable(),
  /**
   * Fresh unread snapshot for the thread's agent (same shape as the unreads
   * endpoint). Clients should treat `chatThreadReadCursorUpdated` as
   * read-state invalidation.
   */
  unreads: chatThreadUnreadsSchema.shape.unreads,
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
    body: z.object({
      agentId: z.string().min(1),
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
    query: z
      .object({
        eventId: chatThreadEventIdSchema.optional(),
        pinOrder: z.string().min(2).max(2048).optional(),
      })
      .optional(),
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
    body: z.object({
      pinOrder: z.string().min(2).max(2048),
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
    query: z.object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
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
    body: z.object({
      title: z.string().min(1),
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
      200: z.object({
        selections: z.array(connectorAccountSelectionSchema),
        selectedConnections: z.array(connectorAccountConnectionSchema),
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
 * Update a chat thread's video model pin. Separate from the model-selection
 * route because it shares none of its provider, tier, or policy resolution.
 */
export const chatThreadVideoModelContract = c.router({
  update: {
    method: "POST",
    path: "/api/chat-threads/:id/video-model",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: chatThreadVideoModelUpdateBodySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update a chat thread video model",
  },
});

/**
 * Update a chat thread's image model pin. Separate from model-selection and
 * video-model because it has its own catalog and default resolution.
 */
export const chatThreadImageModelContract = c.router({
  update: {
    method: "POST",
    path: "/api/chat-threads/:id/image-model",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: chatThreadImageModelUpdateBodySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update a chat thread image model",
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
    body: z
      .object({
        computerUseHostId: z.string().uuid().nullable(),
        cloudBrowserEnabled: z.boolean().optional(),
        eventId: chatThreadEventIdSchema.optional(),
      })
      .refine(
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
    body: z.union([
      chatEventNormalSendBodySchema,
      z
        .object({
          agentId: z.string().min(1),
          threadId: z.string().min(1),
          revokesEventId: z.string().min(1),
          clientEventId: z.string().uuid().optional(),
          prompt: z.undefined().optional(),
          clientThreadId: z.undefined().optional(),
          chatThreadEventId: z.undefined().optional(),
          chatThreadSortEventId: z.undefined().optional(),
          sourceRunId: z.undefined().optional(),
          model: z.undefined().optional(),
          runOptions: z.undefined().optional(),
          userMessage: z.undefined().optional(),
          computerUseHostId: z.undefined().optional(),
          hasTextContent: z.undefined().optional(),
          realAgentInPreview: z.undefined().optional(),
          captureNetworkBodies: z.undefined().optional(),
          interruptsRunId: z.undefined().optional(),
        })
        .strict(),
      z
        .object({
          agentId: z.string().min(1),
          threadId: z.string().min(1),
          interruptsRunId: z.string().uuid(),
          clientEventId: z.string().uuid().optional(),
          prompt: z.undefined().optional(),
          clientThreadId: z.undefined().optional(),
          chatThreadEventId: z.undefined().optional(),
          chatThreadSortEventId: z.undefined().optional(),
          sourceRunId: z.undefined().optional(),
          model: z.undefined().optional(),
          runOptions: z.undefined().optional(),
          userMessage: z.undefined().optional(),
          computerUseHostId: z.undefined().optional(),
          hasTextContent: z.undefined().optional(),
          realAgentInPreview: z.undefined().optional(),
          captureNetworkBodies: z.undefined().optional(),
          revokesEventId: z.undefined().optional(),
        })
        .strict(),
    ]),
    responses: {
      201: z.object({
        runId: z.string().nullable(),
        threadId: z.string(),
        status: runStatusSchema.optional(),
        createdAt: z.string().optional(),
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
    summary: "Append a chat event and dispatch input when applicable",
  },
});

/**
 * Single chat message in a search result.
 * `(chatThreadId, seqId)` is the stable identity and `runId` carries optional
 * run ownership.
 */
const chatSearchMessageSchema = z.object({
  chatThreadId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
  seqId: z.number().int().positive(),
  runId: z.string().nullable(),
});

const chatSearchMatchRangeSchema = z.object({
  /** UTF-16 code-unit offset, compatible with JavaScript String.slice. */
  start: z.number().int().nonnegative(),
  /** Exclusive UTF-16 code-unit offset. */
  end: z.number().int().positive(),
});

const chatSearchResultSchema = z.object({
  chatThreadId: z.string(),
  agentName: z.string(),
  matchedMessage: chatSearchMessageSchema,
  matchedRanges: z.array(chatSearchMatchRangeSchema),
});

export const CHAT_SEARCH_RESULT_LIMIT = 25;

/** The newest matching messages, capped at 25 without pagination. */
const chatSearchResponseSchema = z.object({
  results: z.array(chatSearchResultSchema).max(CHAT_SEARCH_RESULT_LIMIT),
});

/**
 * Chat search contract (GET /api/chat/search)
 * Searches chat messages within the caller's own threads in the caller's org.
 * Authorization is enforced at the DB query level via userId + orgId filters.
 */
export const chatSearchContract = c.router({
  search: {
    method: "GET",
    path: "/api/chat/search",
    headers: authHeadersSchema,
    query: z.object({
      keyword: z.string().trim().min(1),
      agentId: z.string().uuid().optional(),
      since: z.coerce.number().optional(),
    }),
    responses: {
      200: chatSearchResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Search up to 25 newest chat messages within caller's org",
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
    headers: chatEventReadHeadersSchema,
    body: chatEventCatchUpBodySchema,
    responses: {
      200: chatEventCatchUpResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      426: apiErrorSchema,
    },
    summary: "Catch up raw chat events for multiple threads",
  },
  /**
   * Snapshot-read cold start: a presigned download for the thread's head
   * archive object. The object is gzip NDJSON of chatEventRowSchema lines
   * stored with `Content-Encoding: gzip`, so a browser fetch decompresses it
   * transparently. The request header selects the Chat Event schema version.
   */
  snapshot: {
    method: "GET",
    path: "/api/chat-threads/:threadId/event-snapshot",
    headers: chatEventReadHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    responses: {
      200: chatEventSnapshotResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
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
    headers: chatEventReadHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    query: z.union([
      z.object({
        sinceSeqId: z.coerce.number().pipe(z.literal(0)),
        sinceEventId: z.never().optional(),
        limit: z.coerce.number().min(1).max(50).default(50),
      }),
      z.object({
        sinceSeqId: z.coerce.number().int().positive(),
        sinceEventId: z.string().uuid(),
        limit: z.coerce.number().min(1).max(50).default(50),
      }),
    ]),
    responses: {
      200: z.object({
        rows: z.array(chatEventRowSchema),
        cursor: chatEventCursorSchema,
        hasMore: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
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
      200: z.object({
        runs: z.array(chatThreadArtifactRunSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List uploaded files associated with every run in a chat thread",
  },
  syncGoogleDrive: {
    method: "POST",
    path: "/api/chat-threads/:threadId/artifacts",
    headers: authHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    body: z.object({
      runId: z.string(),
      fileId: z.string(),
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
    summary: "Sync a chat artifact file to the user's connected Google Drive",
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
export type ChatSearchResponse = z.infer<typeof chatSearchResponseSchema>;
export type ChatSearchResult = z.infer<typeof chatSearchResultSchema>;
export type ChatSearchMessage = z.infer<typeof chatSearchMessageSchema>;

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

export type CodexServiceTier = z.infer<typeof codexServiceTierSchema>;
export type ChatThreadServiceTier = z.infer<typeof chatThreadServiceTierSchema>;
export type ChatRunOptionsRequest = z.infer<typeof chatRunOptionsRequestSchema>;
export type ChatRunVideoOptionsRequest = z.infer<
  typeof chatRunVideoOptionsRequestSchema
>;
export type GenerationTemplateRequest = z.infer<
  typeof generationTemplateRequestSchema
>;
export type GenerationTemplateType = GenerationTemplateRequest["type"];
export type FeedbackNotePart = z.infer<typeof feedbackNotePartSchema>;
export type UserMessageInputPart = z.infer<typeof userMessageInputPartSchema>;
export type UserMessageInputDocument = z.infer<
  typeof userMessageInputDocumentSchema
>;
export type UserMessagePart = z.infer<typeof userMessagePartSchema>;
export type UserMessageDocument = z.infer<typeof userMessageDocumentSchema>;
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
export type PresentationGenerationTemplateRequest = z.infer<
  typeof presentationGenerationTemplateRequestSchema
>;
export type AvatarGenerationOptions = z.infer<
  typeof avatarGenerationOptionsSchema
>;
export type VideoGenerationTemplateRequest = z.infer<
  typeof videoGenerationTemplateRequestSchema
>;
export type IllustrationGenerationTemplateRequest = z.infer<
  typeof illustrationGenerationTemplateRequestSchema
>;
export type WorkflowGenerationTemplateRequest = z.infer<
  typeof workflowGenerationTemplateRequestSchema
>;
export type WebsiteGenerationTemplateRequest = z.infer<
  typeof websiteGenerationTemplateRequestSchema
>;

export type SummaryEntry = z.infer<typeof summaryEntrySchema>;
export type ChatThreadSnapshotProjection = z.infer<
  typeof chatThreadSnapshotProjectionSchema
>;
export type ChatThreadEvent = z.infer<typeof chatThreadEventSchema>;
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>;
export type ChatThreadMetadata = z.infer<typeof chatThreadMetadataSchema>;
export type ChatThreadDraft = z.infer<typeof chatThreadDraftSchema>;
export type ChatEvent = z.infer<typeof chatEventSchema>;
export type ChatEventSendBody = z.infer<typeof chatEventsContract.send.body>;
export type Indicator = z.infer<typeof indicatorSchema>;
export type Indicators = z.infer<typeof indicatorsSchema>;

export function chatEventResponse(event: ChatEvent): ChatEvent {
  return chatEventSchema.parse(event);
}

export type ChatInputEvent = Extract<
  ChatEvent,
  {
    eventType:
      | "input.prompt"
      | "input.automation"
      | "input.goal"
      | "input.budget"
      | "input.rejected";
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
export type ChatEventUsagePayload = z.infer<typeof chatEventUsagePayloadSchema>;
export type PersistedAttachment = z.infer<typeof persistedAttachmentSchema>;
export type ImageAnnotation = z.infer<typeof imageAnnotationSchema>;
export type ImageAnnotationMark = z.infer<typeof imageAnnotationMarkSchema>;
export type ImageAnnotationMarkShape = ImageAnnotationMark["shape"];
export type AttachFile = z.infer<typeof attachFileSchema>;
export type AssetRef = z.infer<typeof assetRefSchema>;
export type ResolvedAttachFile = z.infer<typeof resolvedAttachFileSchema>;
export type ChatThreadArtifactFile = z.infer<
  typeof chatThreadArtifactFileSchema
>;
export type ChatThreadArtifactGoogleDriveSync = z.infer<
  typeof chatThreadArtifactGoogleDriveSyncSchema
>;
export type ChatThreadArtifactGoogleDriveRecovery = z.infer<
  typeof chatThreadArtifactGoogleDriveRecoverySchema
>;
export type ChatThreadArtifactRun = z.infer<typeof chatThreadArtifactRunSchema>;
