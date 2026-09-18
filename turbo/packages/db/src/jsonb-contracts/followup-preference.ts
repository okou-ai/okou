/** Validated recommendation sources captured when a human submits a prompt. */
export interface FollowupEvidenceOrigin {
  readonly eventId: string;
  readonly index: number;
  readonly prompt: string;
}

export type FollowupEvidenceOrigins = readonly FollowupEvidenceOrigin[];

/** Separate authored wording from adoption of model-written wording. */
export type FollowupEvidenceKind =
  | "unattributed"
  | "adopted"
  | "edited"
  | "mixed"
  | "unresolved";
