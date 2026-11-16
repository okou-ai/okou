export const PRESENTATION_OUTPUT_FORMATS = ["html", "pptx"] as const;

export type PresentationOutputFormat =
  (typeof PRESENTATION_OUTPUT_FORMATS)[number];
