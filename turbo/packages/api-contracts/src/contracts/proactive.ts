import { z } from "zod";

export type ProactiveWorkflowKind = "suggestions" | "action" | "jobs";

export const proactivePreferenceSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(["preparing", "enabled", "paused", "error"]),
  unavailableReason: z
    .enum(["missing-default-agent", "proactive-action-enabled"])
    .nullable(),
});

export type ProactivePreference = z.infer<typeof proactivePreferenceSchema>;
