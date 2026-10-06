/** Native Google model configuration shared by text and voice generation. */
export const VERTEX_MODELS = {
  "google/gemini-3.1-flash-lite": {
    model: "gemini-3.1-flash-lite",
    location: "us",
    host: "aiplatform.us.rep.googleapis.com",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "MINIMAL" },
      temperature: 0,
    },
  },
  "google/gemini-3.8-flash": {
    model: "gemini-3.8-flash",
    location: "us",
    host: "aiplatform.us.rep.googleapis.com",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "LOW" },
    },
  },
} as const;

export type VertexModel = keyof typeof VERTEX_MODELS;
export const VERTEX_TEXT_MODEL =
  "google/gemini-3.1-flash-lite" satisfies VertexModel;
export const VERTEX_FOLLOWUP_MODEL =
  "google/gemini-3.8-flash" satisfies VertexModel;
