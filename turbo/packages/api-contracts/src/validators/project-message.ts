import {
  array,
  literal,
  number,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import {
  userMessageInputPartSchema,
  userMessagePartSchema,
  feedbackNotePartSchema,
  composerDraftSchema,
} from "./chat-threads";
import { requireUserMessageForDraftAttachments } from "../contracts/draft-user-message";

export const projectMentionSchema = object({
  type: literal("project"),
  projectId: uuid(),
  nameSnapshot: string().min(1).max(120),
}).strict();
export type ProjectMention = zInfer<typeof projectMentionSchema>;
const projectFeedbackSchema = object({
  type: literal("feedback"),
  quote: string().min(1),
  note: array(union([feedbackNotePartSchema, projectMentionSchema])),
  eventId: string().min(1).optional(),
  range: object({
    start: number().int().nonnegative(),
    end: number().int().positive(),
  })
    .strict()
    .refine((r) => {
      return r.end > r.start;
    })
    .optional(),
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
  .refine((p) => {
    return (p.eventId === undefined) === (p.range === undefined);
  });
export const projectInputPartSchema = union([
  userMessageInputPartSchema,
  projectMentionSchema,
  projectFeedbackSchema,
]);
export const projectMessagePartSchema = union([
  userMessagePartSchema,
  projectInputPartSchema,
]);
const validAnnotations = (parts: readonly { type: string }[]) => {
  return (
    parts.filter((p) => {
      return p.type === "source" || p.type === "automation";
    }).length <= 1
  );
};
export const projectInputDocumentSchema = object({
  version: literal(1),
  parts: array(projectInputPartSchema).min(1).refine(validAnnotations),
}).strict();
export const projectMessageDocumentSchema = object({
  version: literal(1),
  parts: array(projectMessagePartSchema)
    .min(1)
    .refine(validAnnotations)
    .refine((parts) => {
      return (
        parts.filter((p) => {
          return p.type === "model";
        }).length <= 1
      );
    }),
}).strict();
export const projectComposerDraftSchema = object({
  ...composerDraftSchema.shape,
  draftUserMessage: projectInputDocumentSchema.nullable(),
}).superRefine(requireUserMessageForDraftAttachments);
export type ProjectMessagePart = zInfer<typeof projectMessagePartSchema>;
export type ProjectInputPart = zInfer<typeof projectInputPartSchema>;
export type ProjectMessageDocument = zInfer<
  typeof projectMessageDocumentSchema
>;
export type ProjectInputDocument = zInfer<typeof projectInputDocumentSchema>;
