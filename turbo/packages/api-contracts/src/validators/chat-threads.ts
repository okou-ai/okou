import {
  modelSettingsPatchSchema,
  modelSettingsSchema,
  reasoningEffortSchema,
} from "../contracts/model-reasoning-effort";
import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  preprocess,
  record,
  string,
  url,
  uuid,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";
import { requireUserMessageForDraftAttachments } from "../contracts/draft-user-message";

export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

const annotationPointSchema = object({
  x: number(),
  y: number(),
});

const annotationRectSchema = object({
  x: number(),
  y: number(),
  width: number(),
  height: number(),
});

/**
 * Ink is stored as a literal hex rather than a palette enum: the palette is a
 * design decision that will move, and an enum would turn every future palette
 * edit into a read migration for annotations already sitting in the database.
 * The client picks from `ANNOTATION_INKS`; this boundary only rejects garbage.
 */
const annotationInkSchema = string().regex(/^#[0-9A-Fa-f]{6}$/);

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
const markOrdinalSchema = number().int().positive().optional();

export const imageAnnotationMarkSchema = discriminatedUnion("shape", [
  object({
    id: string(),
    ordinal: markOrdinalSchema,
    shape: literal("box"),
    rect: annotationRectSchema,
    ink: annotationInkSchema,
    note: string().optional(),
  }),
  object({
    id: string(),
    ordinal: markOrdinalSchema,
    shape: literal("arrow"),
    from: annotationPointSchema,
    to: annotationPointSchema,
    ink: annotationInkSchema,
    note: string().optional(),
  }),
  object({
    id: string(),
    ordinal: markOrdinalSchema,
    shape: literal("pen"),
    points: array(annotationPointSchema),
    ink: annotationInkSchema,
    note: string().optional(),
  }),
  object({
    id: string(),
    ordinal: markOrdinalSchema,
    shape: literal("text"),
    at: annotationPointSchema,
    text: string(),
    ink: annotationInkSchema,
    /**
     * Type size as a multiple of the base label size, set by dragging a corner
     * of the label. Absent means 1: a mark placed before the handles existed,
     * or one nobody resized.
     */
    scale: number().min(0.5).max(4).optional(),
  }),
  // Highlight and redact carry no ink: a highlight is always the one yellow
  // wash, and a redaction is an opaque neutral block — colouring either would
  // make it read as a mark instead of as a state of the image.
  object({
    id: string(),
    ordinal: markOrdinalSchema,
    shape: literal("highlight"),
    rect: annotationRectSchema,
    note: string().optional(),
  }),
  object({
    id: string(),
    ordinal: markOrdinalSchema,
    shape: literal("redact"),
    rect: annotationRectSchema,
  }),
]);

export const imageAnnotationSchema = object({
  marks: array(imageAnnotationMarkSchema),
  /** Normalized crop applied before the marks are drawn. */
  crop: annotationRectSchema.optional(),
});

/**
 * Filename the rendered derivative is uploaded under, derived from the
 * original so the pair reads together in any list that shows both.
 *
 * This shared helper keeps the app's filename aligned with the API's artifact
 * lookup hint. Two independently deployed copies
 * would drift silently: the exact-key lookup would miss and degrade into a
 * prefix listing while the agent prompt showed a name no artifact has.
 */
export function annotatedImageFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem}.annotated.png`;
}

/**
 * Attachment metadata persisted in chat_threads.draft_attachments.
 *
 * `url` is the public artifact CDN URL.
 * Historically this stored a 7-day presigned URL that could silently expire
 * while drafts sat in the DB; the public artifact URL removes that footgun.
 */
export const persistedAttachmentSchema = object({
  id: string(),
  url: string(),
  filename: string(),
  contentType: string(),
  size: number(),
});

export const indicatorSchema = zEnum(["active", "unread"]);

/**
 * Bounded presentation indicators for the caller's threads and visible Agents
 * in the current organization, not authoritative per-Run lifecycle status.
 * `active` reflects eligible pending/running Runs. `unread` reflects a Run
 * terminal marker newer than the thread's read watermark, including completed,
 * failed and cancelled outcomes; it does not establish successful completion.
 * Thread active takes precedence over unread. At the Agent level unread takes
 * precedence, so an unread Agent can still have an active thread.
 *
 * Reads are non-atomic and may observe different states during Run transitions.
 * They cover up to 128 newest visible Agents, 50 active threads and 50 unread
 * threads. Unread selection examines up to 128 newest unmuted candidate threads
 * with messages after their read watermark within seven days, and terminal
 * markers within that lookback. Missing entries do not prove inactivity,
 * completion, complete output or that all messages are read. No refresh deadline
 * or eventual appearance is guaranteed for excluded entries.
 *
 * To establish a known Run's outcome, inspect the known thread's public event
 * rows for its matching runId and run.completed, run.failed or run.cancelled.
 * Read the snapshot archive when present and follow paired-cursor pages through
 * chatThreadEventsContract. If matching evidence is unavailable, retain
 * uncertainty; an activity summary is not exact lifecycle evidence. Reading
 * indicators or event history does not advance the thread's read watermark.
 */
export const indicatorsSchema = object({
  agents: record(string().uuid(), indicatorSchema),
  threads: record(string().uuid(), indicatorSchema),
  /** Latest unread marker for each thread marked unread above. */
  unreadAt: record(string().uuid(), string().datetime()),
});

export const chatThreadEventIdSchema = string().uuid();
export const chatThreadServiceTierSchema = zEnum(["priority"]);
/**
 * Persisted thread events, snapshot archives, and client caches can still carry
 * the retired Ultrafast tier. Read it as the Standard tier instead of failing.
 */
const persistedChatThreadServiceTierSchema = zEnum(["priority", "ultrafast"])
  .nullable()
  .default(null)
  .transform((tier) => {
    return tier === "priority" ? tier : null;
  })
  .pipe(chatThreadServiceTierSchema.nullable());

export const chatThreadSnapshotProjectionSchema = object({
  id: string().uuid(),
  agentId: string().uuid(),
  title: string().nullable(),
  sortAt: string(),
  createdAt: string(),
  updatedAt: string(),
  pinnedAt: string().nullable(),
  // Optional for existing snapshots and browser caches without manual ordering.
  pinOrder: string().nullable().optional(),
  archived: boolean(),
  hidden: boolean().optional(),
  muted: boolean().optional(),
  renamedAt: string().nullable(),
  selectedModel: string().nullable().default(null),
  modelSettings: modelSettingsSchema.optional(),
  /** Legacy pre-GA projection. Ignored by current clients. */
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  serviceTier: persistedChatThreadServiceTierSchema,
  computerUseHostId: string().uuid().nullable().default(null),
  cloudBrowserEnabled: boolean().optional(),
});

export const chatThreadSnapshotArchiveSchema = object({
  chatThreads: array(chatThreadSnapshotProjectionSchema),
});

export const chatThreadEventSchema = object({
  id: chatThreadEventIdSchema,
  /** Server-assigned strict position within the user/org event stream. */
  seqId: number().int().positive(),
  kind: zEnum([
    "created",
    "renamed",
    "deleted",
    "pinned",
    "unpinned",
    "model_selection_updated",
    "service_tier_updated",
    "computer_use_host_updated",
    "sort_touched",
    "archived",
    "unarchived",
  ]),
  chatThreadId: string().uuid(),
  agentId: string().uuid(),
  /** On sort_touched, an explicit canonical agent reassignment. */
  reassignedAgentId: string().uuid().optional(),
  title: string().nullable(),
  // On sort_touched, this changes pin rank instead of activity recency.
  pinOrder: string().nullable().optional(),
  /** On sort_touched, a metadata-only mute change, not an activity touch. */
  muted: boolean().optional(),
  /** System visibility metadata; omitted events leave it unchanged. */
  hidden: boolean().optional(),
  selectedModel: string().nullable().default(null),
  /** Full map is present on created events. */
  modelSettings: modelSettingsSchema.optional(),
  /** Later updates change at most one model entry. */
  modelSettingsPatch: modelSettingsPatchSchema.optional(),
  /** Legacy pre-GA projection. Ignored by current clients. */
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  serviceTier: persistedChatThreadServiceTierSchema,
  computerUseHostId: string().uuid().nullable().default(null),
  cloudBrowserEnabled: boolean().optional(),
  createdAt: string(),
});

export const presentationGenerationTemplateRequestSchema = object({
  type: literal("presentation"),
  selection: object({
    templateId: string().min(1),
    colorSystemId: string().min(1).optional(),
    previewUrl: string().url().optional(),
  }).strict(),
});

const avatarVideoAspectRatioSchema = zEnum(["portrait", "landscape", "square"]);
const avatarVideoVoiceIdSchema = string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

/**
 * Talking-avatar parameters. Unrelated to text-to-video despite sharing the
 * "video" envelope.
 *
 * What keeps this envelope shared is persisted data, not client parsing: avatar
 * selections have always been stored as `type: "video"` with the product
 * encoded in `stylePresetId`, and those rows are customer data. Splitting them
 * apart would need the backfill and phasing in
 * `docs/deployment-compatibility.md` first.
 */
export const avatarGenerationOptionsSchema = object({
  titleSnapshot: string().trim().min(1),
  previewUrl: url(),
  voiceId: avatarVideoVoiceIdSchema,
  aspectRatio: avatarVideoAspectRatioSchema,
}).partial();

export const videoGenerationTemplateRequestSchema = object({
  type: literal("video"),
  selection: object({
    stylePresetId: string().min(1),
    avatarOptions: avatarGenerationOptionsSchema.optional(),

    /**
     * Historical flat fields stay parseable because messages and persisted
     * drafts written before avatarOptions was introduced only carry this
     * shape. Dropping them here would strip those selections on parse;
     * retaining the nested schema alone does not preserve those values.
     *
     * @deprecated Read-only fallback; write avatarOptions.titleSnapshot.
     */
    titleSnapshot: string().trim().min(1).optional(),
    /** @deprecated Read-only fallback; write avatarOptions.previewUrl. */
    previewUrl: url().optional(),
    /** @deprecated Read-only fallback; write avatarOptions.voiceId. */
    voiceId: avatarVideoVoiceIdSchema.optional(),
    /** @deprecated Read-only fallback; write avatarOptions.aspectRatio. */
    aspectRatio: avatarVideoAspectRatioSchema.optional(),
  }),
});

/**
 * Intro Video selections written before the product was removed.
 *
 * Read-only. No surface produces this type any more and the prompt builder
 * ignores it, so it contributes no behaviour. It stays in the union because
 * `chat_events` is append-only — `chat_events_reject_update` blocks UPDATE, so
 * the rows can be neither rewritten nor migrated. Dropping the arm makes
 * `userMessageDocumentSchema.parse` throw for every archived message carrying
 * one, which 500s thread sharing and user export. `selection` is unread.
 */
const retiredIntroVideoGenerationTemplateRequestSchema = object({
  type: literal("intro-video"),
  selection: zUnknown(),
});

export const illustrationGenerationTemplateRequestSchema = object({
  type: literal("illustration"),
  selection: object({
    illustrationStyleId: string().min(1),
  }),
});

export const workflowGenerationTemplateRequestSchema = object({
  type: literal("workflow"),
  selection: object({
    workflowTemplateId: string().min(1),
  }),
});

const documentGenerationTemplateRequestSchema = object({
  type: literal("document"),
  selection: object({ documentTemplateId: string().min(1) }).strict(),
});

export const websiteGenerationTemplateRequestSchema = object({
  type: literal("website"),
  selection: object({
    websiteTemplateId: string().min(1),
  }).strict(),
});

/**
 * A template the member's own organization compiled from a file it uploaded.
 *
 * One arm for the whole catalog rather than one per kind: what the template
 * produces is already on its row, and a selection that restated it could
 * disagree with what the reverse run actually wrote. The row id needs no
 * namespace prefix the way a presentation selection does — this arm is the
 * namespace, so it cannot collide with a built-in slug.
 */
const customGenerationTemplateRequestSchema = object({
  type: literal("custom"),
  selection: object({
    userTemplateId: uuid(),
  }).strict(),
});

export const generationTemplateRequestSchema = discriminatedUnion("type", [
  presentationGenerationTemplateRequestSchema,
  customGenerationTemplateRequestSchema,
  videoGenerationTemplateRequestSchema,
  retiredIntroVideoGenerationTemplateRequestSchema,
  illustrationGenerationTemplateRequestSchema,
  workflowGenerationTemplateRequestSchema,
  websiteGenerationTemplateRequestSchema,
  documentGenerationTemplateRequestSchema,
]);

const userMessageTextPartSchema = object({
  type: literal("text"),
  text: string().min(1),
}).strict();

const userMessageChatThreadPartSchema = object({
  type: literal("chat_thread"),
  threadId: string().uuid(),
  titleSnapshot: string().min(1),
}).strict();

const userMessageAgentPartSchema = object({
  type: literal("agent"),
  agentId: string().uuid(),
  nameSnapshot: string().min(1),
}).strict();

const userMessageTemplatePartSchema = object({
  type: literal("template"),
  titleSnapshot: string().min(1),
  template: generationTemplateRequestSchema,
}).strict();

export const feedbackNotePartSchema = discriminatedUnion("type", [
  userMessageTextPartSchema,
  userMessageChatThreadPartSchema,
  userMessageAgentPartSchema,
  userMessageTemplatePartSchema,
]);

const feedbackRangeSchema = object({
  /** UTF-16 code-unit offset, compatible with JavaScript String.slice. */
  start: number().int().nonnegative(),
  /** Exclusive UTF-16 code-unit offset. */
  end: number().int().positive(),
})
  .strict()
  .refine(
    (range) => {
      return range.end > range.start;
    },
    { path: ["end"], message: "Feedback range end must be after start" },
  );

const userMessageExternalSourcePartSchema = object({
  type: literal("source"),
  kind: zEnum([
    "slack",
    "discord",
    "wechat",
    "feishu",
    "lark",
    "teams",
    "telegram",
    "github",
    "agentphone",
  ]),
  href: string().url().optional(),
}).strict();

const userMessageMcpSourcePartSchema = object({
  type: literal("source"),
  kind: literal("mcp"),
  /** OAuth client ID, assigned only by the MCP server, never by a caller. */
  clientId: string()
    .min(1)
    .max(2048)
    .refine((value) => {
      return value.trim().length > 0;
    }),
  /** Display name captured with this message; absent if metadata was unavailable. */
  clientName: string().trim().min(1).max(120).optional(),
}).strict();

const userMessageAgentSourcePartSchema = object({
  type: literal("source"),
  kind: literal("agent"),
  runId: string().uuid(),
  threadId: string().uuid(),
  agentId: string().uuid(),
  titleSnapshot: string().min(1),
  href: string().min(1),
}).strict();

const userMessageSourcePartSchema = discriminatedUnion("kind", [
  userMessageExternalSourcePartSchema,
  userMessageMcpSourcePartSchema,
  userMessageAgentSourcePartSchema,
]);

export const userMessageInputPartSchema = discriminatedUnion("type", [
  userMessageTextPartSchema,
  userMessageChatThreadPartSchema,
  userMessageAgentPartSchema,
  userMessageTemplatePartSchema,
  userMessageSourcePartSchema,
  object({
    /** Client-authored context included in agent prompts, not visible text. */
    type: literal("additional_info"),
    text: string().min(1),
  }).strict(),
  object({
    type: literal("automation"),
    workflowName: string().min(1),
    workflowId: string().uuid().optional(),
    automationBrief: string().optional(),
  }).strict(),
  object({
    type: literal("file"),
    fileId: string().min(1),
    filenameSnapshot: string().min(1),
    contentType: string().min(1),
    /** Rendered derivative produced from the original file and annotations. */
    annotatedFileId: string().min(1).optional(),
    /** Editable marks sufficient to reconstruct the confirmed result. */
    annotations: imageAnnotationSchema.optional(),
  }).strict(),
  object({
    type: literal("feedback"),
    quote: string().min(1),
    note: array(feedbackNotePartSchema),
    eventId: string().min(1).optional(),
    range: feedbackRangeSchema.optional(),
    source: object({
      type: literal("mail"),
      id: string().min(1),
      status: zEnum(["draft", "sent"]),
      sentId: string().min(1).optional(),
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

/**
 * Model parts are written by the API into append-only chat events. Events
 * stored while Ultrafast was offered can still carry it; read it as the
 * Standard tier (absent) instead of failing the whole message.
 */
const persistedUserMessageServiceTierSchema = preprocess((tier) => {
  return tier === "ultrafast" ? undefined : tier;
}, chatThreadServiceTierSchema.optional());

const userMessageModelPartSchema = object({
  type: literal("model"),
  selectedModel: string().min(1),
  serviceTier: persistedUserMessageServiceTierSchema,
}).strict();

export const userMessagePartSchema = discriminatedUnion("type", [
  ...userMessageInputPartSchema.options,
  userMessageModelPartSchema,
]);

export const userMessageDocumentSchema = object({
  version: literal(1),
  parts: array(userMessagePartSchema)
    .min(1)
    .refine(
      (parts) => {
        return (
          parts.filter((part) => {
            return part.type === "source" || part.type === "automation";
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
}).strict();

export const userMessageInputDocumentSchema = object({
  version: literal(1),
  parts: array(userMessageInputPartSchema)
    .min(1)
    .refine(
      (parts) => {
        return (
          parts.filter((part) => {
            return part.type === "source" || part.type === "automation";
          }).length <= 1
        );
      },
      { message: "A user message may contain at most one non-content part" },
    ),
}).strict();

const chatEventRecommendedFollowupShape = {
  prompt: string(),
  kind: zEnum(["talk", "generate"]),
  generationType: zEnum([
    "image",
    "video",
    "presentation",
    "website",
  ]).optional(),
};

export const chatFollowupsContentDocumentSchema = object({
  version: literal(1),
  followups: array(object(chatEventRecommendedFollowupShape).strict()),
}).strict();

export type ChatRecommendedFollowup = zInfer<
  typeof chatFollowupsContentDocumentSchema
>["followups"][number];
export type ChatFollowupsContentDocument = zInfer<
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

export const composerDraftSchema = object({
  draftUserMessage: userMessageInputDocumentSchema.nullable(),
  draftAttachments: array(persistedAttachmentSchema).nullable(),
}).superRefine(requireUserMessageForDraftAttachments);
