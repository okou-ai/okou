import { z } from "zod";

export type ProactiveWorkflowKind =
  "suggestions" | "jobs" | "learning" | "planning";

export const proactivePreferenceSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(["preparing", "enabled", "paused", "error"]),
  unavailableReason: z
    .enum(["missing-default-agent", "missing-timezone"])
    .nullable(),
});

export type ProactivePreference = z.infer<typeof proactivePreferenceSchema>;
