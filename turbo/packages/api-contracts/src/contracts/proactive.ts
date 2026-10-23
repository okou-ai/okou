import { z } from "zod";

export type ProactiveWorkflowKind = "suggestions" | "jobs";

export const proactivePreferenceSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(["preparing", "enabled", "paused", "error"]),
  unavailableReason: z.literal("missing-default-agent").nullable(),
});

export type ProactivePreference = z.infer<typeof proactivePreferenceSchema>;
