import {
  literal,
  object,
  preprocess,
  string,
  union,
  uuid,
  type infer as zInfer,
} from "zod";
import {
  chatThreadEventSchema,
  userMessageDocumentSchema,
} from "../validators/chat-threads";

/** Reader preparation only. The production API keeps its current event enum. */
export const projectAwareChatThreadEventSchema = union([
  chatThreadEventSchema,
  chatThreadEventSchema.extend({
    kind: literal("project_updated"),
    projectId: uuid().nullable(),
  }),
]);
export type ProjectAwareChatThreadEvent = zInfer<
  typeof projectAwareChatThreadEventSchema
>;

export const projectReferencePartSchema = object({
  type: literal("project"),
  projectId: uuid(),
  nameSnapshot: string().min(1),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readableProjectReference(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "project") {
    return value;
  }
  const parsed = projectReferencePartSchema.safeParse(value);
  if (!parsed.success) {
    return value;
  }
  const part = parsed.data;
  const label = part.nameSnapshot.replace(/[\\[\]]/g, String.raw`\$&`);
  return { type: "text", text: `[${label}](/projects/${part.projectId})` };
}

function readableProjectPart(value: unknown): unknown {
  if (
    isRecord(value) &&
    value.type === "feedback" &&
    Array.isArray(value.note)
  ) {
    return { ...value, note: value.note.map(readableProjectReference) };
  }
  return readableProjectReference(value);
}

/**
 * Preparation-only display projection. Preserve the ID/name as a portable link
 * while raw event storage retains the structured part unchanged. Activation
 * replaces this projection with the canonical Project part/editor rendering.
 */
export const projectAwareUserMessageDocumentSchema = preprocess((value) => {
  if (!isRecord(value) || !Array.isArray(value.parts)) {
    return value;
  }
  return { ...value, parts: value.parts.map(readableProjectPart) };
}, userMessageDocumentSchema);
