import {
  boolean,
  discriminatedUnion,
  enum as zEnum,
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
  schemaVersion: literal(2),
  status: literal("accepted"),
}).strict();
export type RunPhaseMarkResult = zInfer<typeof runPhaseMarkResultSchema>;

export const runPhaseTimingContract = initContract().router({
  mark: {
    method: "POST",
    path: "/api/runs/current/phase-mark",
    headers: authHeadersSchema,
    body: runPhaseMarkSchema,
    responses: {
      202: runPhaseMarkResultSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Accept a best-effort phase observation for the authenticated Run",
  },
});
