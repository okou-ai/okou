type VoiceResponseFailureReason =
  | "invalid_response"
  | "response_too_large"
  | "missing_choices"
  | "output_truncated"
  | "non_stop"
  | "empty_output"
  | "invalid_output"
  | "http"
  | "completion"
  | "not_configured"
  | "stitched_transcript_too_large"
  | "transcription_rate_exceeded"
  | "polish_rate_exceeded"
  | "polish_discarded_speech";

/** A finite cause, without retaining provider output or the original error. */
export class VoiceResponseError extends Error {
  constructor(
    readonly reason: VoiceResponseFailureReason,
    readonly diagnosticOwner: "segment" | "provider" = "segment",
  ) {
    super("Voice response was unusable");
    this.name = "VoiceResponseError";
  }
}
