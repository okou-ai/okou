import { array, number, object, string } from "zod";

const count = number().int().nonnegative();
const usageSchema = object({
  promptTokenCount: count,
  candidatesTokenCount: count,
  thoughtsTokenCount: count.default(0),
  promptTokensDetails: array(object({ modality: string(), tokenCount: count })),
  cachedContentTokenCount: count.default(0),
  cacheTokensDetails: array(
    object({ modality: string(), tokenCount: count }),
  ).default([]),
});

export function voiceTranscriptionUsage(value: unknown) {
  const usage = usageSchema.parse(value);
  function inputs(details: typeof usage.promptTokensDetails, expected: number) {
    let audio = 0,
      text = 0;
    for (const { modality, tokenCount } of details) {
      if (modality === "AUDIO") {
        audio += tokenCount;
      } else if (modality === "TEXT") {
        text += tokenCount;
      } else {
        throw new Error("Unexpected transcription input modality");
      }
    }
    if (audio + text !== expected) {
      throw new Error("Incomplete transcription input usage");
    }
    return { audio, text };
  }
  const all = inputs(usage.promptTokensDetails, usage.promptTokenCount);
  const cached = inputs(
    usage.cacheTokensDetails,
    usage.cachedContentTokenCount,
  );
  if (cached.audio > all.audio || cached.text > all.text) {
    throw new Error("Invalid cached transcription inputs");
  }
  return {
    textTokens: all.text - cached.text,
    audioTokens: all.audio - cached.audio,
    cachedTextTokens: cached.text,
    cachedAudioTokens: cached.audio,
    outputTokens: usage.candidatesTokenCount + usage.thoughtsTokenCount,
  };
}
