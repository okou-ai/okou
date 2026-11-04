import { boolean, object, enum as zEnum, type infer as zInfer } from "zod";

export type ProactiveWorkflowKind = "suggestions" | "learning";

export const proactivePreferenceSchema = object({
  enabled: boolean(),
  status: zEnum(["preparing", "enabled", "paused", "error"]),
  unavailableReason: zEnum([
    "missing-default-agent",
    "missing-timezone",
  ]).nullable(),
});

export type ProactivePreference = zInfer<typeof proactivePreferenceSchema>;
