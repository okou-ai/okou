import { enum as zEnum } from "zod";

export const ORG_OPENROUTER_PRESETS = [
  "@preset/okou-1-0",
  "@preset/okou-1-0-dsf",
  "@preset/okou-experimental",
] as const;

export const orgOpenrouterPresetSchema = zEnum(ORG_OPENROUTER_PRESETS);
