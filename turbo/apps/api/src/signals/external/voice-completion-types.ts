/** Base64-encoded 16 kHz PCM WAV. */
export interface VoiceAudio {
  readonly data: string;
}
export type VoiceContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "audio"; readonly audio: VoiceAudio };
/** String fields requested from Vertex; local Zod schemas own strict validation. */
export interface VoiceJsonSchema {
  readonly name: string;
  readonly properties: Readonly<
    Record<string, { readonly description?: string }>
  >;
  readonly required: readonly string[];
}
export interface VoiceCompletionRequest {
  readonly systemPrompt: string;
  readonly content: string | readonly VoiceContentPart[];
  readonly jsonSchema?: VoiceJsonSchema;
}
