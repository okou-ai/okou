import type { MultimodalVoiceInputModelId } from "@okouai/api-contracts/contracts/voice-input-models";

export interface VoiceAudio {
  readonly data: string;
  readonly format: "wav";
}
export type VoiceContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "audio"; readonly audio: VoiceAudio };
export interface VoiceJsonSchema {
  readonly name: string;
  readonly strict: true;
  readonly schema: {
    readonly type: "object";
    readonly properties: Readonly<
      Record<
        string,
        {
          readonly type: "string";
          readonly minLength: number;
          readonly maxLength: number;
          readonly description?: string;
        }
      >
    >;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}
export interface VoiceCompletionRequest {
  readonly model: MultimodalVoiceInputModelId;
  readonly systemPrompt: string;
  readonly content: string | readonly VoiceContentPart[];
  readonly jsonSchema?: VoiceJsonSchema;
}
