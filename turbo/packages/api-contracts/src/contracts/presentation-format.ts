import { PRESENTATION_OUTPUT_FORMATS } from "../validators/presentation-output-format";
import {
  array,
  discriminatedUnion,
  iso,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const presentationFormatSchema = zEnum(PRESENTATION_OUTPUT_FORMATS);

/** An inline Web card action, not a navigable page or an authorization grant. */
export const presentationFormatCardSchema = object({
  type: literal("presentation_format_selection"),
  sourceRunId: uuid(),
  threadId: uuid(),
  continuationEventId: uuid(),
  requestedFormat: presentationFormatSchema.nullable(),
  formats: array(presentationFormatSchema).min(1),
  action: object({
    method: literal("POST"),
    path: literal("/api/presentation-format/confirm"),
  }).strict(),
}).strict();

export const resolvePresentationFormatResponseSchema = discriminatedUnion(
  "status",
  [
    object({
      status: literal("ready"),
      presentationFormat: presentationFormatSchema,
    }).strict(),
    object({
      status: literal("selection_required"),
      sourceRunId: uuid(),
      threadId: uuid(),
      continuationEventId: uuid(),
      requestedFormat: presentationFormatSchema.nullable(),
      card: presentationFormatCardSchema,
    }).strict(),
  ],
);

export const confirmPresentationFormatResponseSchema = object({
  status: literal("accepted"),
  sourceRunId: uuid(),
  threadId: uuid(),
  continuationEventId: uuid(),
  presentationFormat: presentationFormatSchema,
  acceptedAt: iso.datetime(),
}).strict();

export const presentationFormatConflictSchema = object({
  error: object({ code: string(), message: string() }),
  /** The accepted task choice, or the current default when no input was accepted. */
  presentationFormat: presentationFormatSchema.nullable(),
});

export type ConfirmPresentationFormatResponse = zInfer<
  typeof confirmPresentationFormatResponseSchema
>;
export type ResolvePresentationFormatResponse = zInfer<
  typeof resolvePresentationFormatResponseSchema
>;

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: presentationFormatConflictSchema,
  410: apiErrorSchema,
  503: apiErrorSchema,
};
export const presentationFormatContract = c.router({
  resolve: {
    method: "POST",
    path: "/api/presentation-format/resolve",
    headers: authHeadersSchema,
    body: object({
      requestedFormat: presentationFormatSchema.optional(),
    }).strict(),
    responses: { 200: resolvePresentationFormatResponseSchema, ...errors },
    summary: "Resolve a presentation format for the current owned Web Run",
  },
  confirm: {
    method: "POST",
    path: "/api/presentation-format/confirm",
    headers: authHeadersSchema,
    body: object({
      sourceRunId: uuid(),
      presentationFormat: presentationFormatSchema,
    }).strict(),
    responses: { 200: confirmPresentationFormatResponseSchema, ...errors },
    summary:
      "Save the initial presentation format and accept the original task continuation",
  },
});
