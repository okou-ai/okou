import { enum as zEnum, type infer as zInfer } from "zod";

export const PRESENTATION_OUTPUT_FORMATS = ["html", "pptx"] as const;

export const presentationOutputFormatSchema = zEnum(
  PRESENTATION_OUTPUT_FORMATS,
);

export type PresentationOutputFormat = zInfer<
  typeof presentationOutputFormatSchema
>;
