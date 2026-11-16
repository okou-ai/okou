import {
  boolean,
  discriminatedUnion,
  enum as zEnum,
  iso,
  literal,
  object,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const runGenerationKindSchema = zEnum([
  "image",
  "presentation",
  "document",
  "spreadsheet",
  "website",
  "report",
  "video",
  "audio",
  "mixed",
  "other",
]);

export const runPhaseMarkSchema = discriminatedUnion("phase", [
  object({ phase: literal("research-start") }).strict(),
  object({
    phase: literal("generation-start"),
    kind: runGenerationKindSchema,
    skipResearch: boolean().default(false),
  }).strict(),
]);
export type RunPhaseMark = zInfer<typeof runPhaseMarkSchema>;

export const runPhaseMarkResultSchema = object({
  schemaVersion: literal(1),
  status: zEnum(["recorded", "duplicate", "ignored"]),
  reason: zEnum([
    "run-not-running",
    "generation-already-started",
    "research-already-started",
    "out-of-order",
  ]).nullable(),
  timing: object({
    researchStartedAt: iso.datetime().nullable(),
    generationStartedAt: iso.datetime().nullable(),
    researchSkipped: boolean(),
    generationKind: runGenerationKindSchema.nullable(),
  }).nullable(),
}).strict();
export type RunPhaseMarkResult = zInfer<typeof runPhaseMarkResultSchema>;

export const runPhaseTimingContract = initContract().router({
  mark: {
    method: "POST",
    path: "/api/runs/current/phase-mark",
    headers: authHeadersSchema,
    body: runPhaseMarkSchema,
    responses: {
      200: runPhaseMarkResultSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Record the first phase boundary for the authenticated Run",
  },
});
