type VoiceResponseFailureReason =
  | "not_configured"
  | "deadline_exceeded"
  | "transcription_rate_exceeded"
  | "polish_rate_exceeded"
  | "polish_discarded_speech";

/** A finite cause, without retaining provider output or the original error. */
export class VoiceResponseError extends Error {
  constructor(readonly reason: VoiceResponseFailureReason) {
    super("Voice response was unusable");
    this.name = "VoiceResponseError";
  }
}
