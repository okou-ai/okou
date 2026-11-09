import { boolean, object, enum as zEnum, type infer as zInfer } from "zod";

export const PROACTIVE_LEARNING_DEFINITION_NAME = "proactive-learning";
export const PROACTIVE_LEARNING_BLUEPRINT_KEY = "nightly-learning";

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
