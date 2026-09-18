/**
 * The bounded, credential-free proof that one supplied source was authorized.
 *
 * It is retained so a later phase — result acceptance, persisted readback, a
 * new delivery admission — can re-run the permission question against live
 * state. Every field exists to identify an input, never to fetch it again: it
 * carries no source body, no prompt, no instruction text and no credential.
 *
 * Readers must tolerate a row written by an older or newer writer. The shape is
 * additive only, and a consumer that does not recognize a field ignores it
 * rather than refusing the proof it does understand.
 */
export interface MorningBriefRetainedSource {
  /** Which provider this input came from. */
  readonly source: string;
  /** The exact selected connection; null for native Slack and for Chat. */
  readonly connectionId: string | null;
  /** The provider account identity actually read, never a credential. */
  readonly accountRef: string | null;
  /** A digest of the authorization surface the read exercised. */
  readonly scopeDigest: string;
  readonly membershipId: string;
  readonly agentId: string;
  readonly capturedAt: string;
  /** Exact policy endpoints to re-check; empty for native Slack and Chat. */
  readonly endpoints: readonly string[];
  /** The real provider containers that contributed, bounded in number. */
  readonly containers: readonly string[];
  /** True when this source's material entered the model input, cited or not. */
  readonly contributed: boolean;
}

/** At most one entry per source, bounded by the composition's own ceiling. */
export type MorningBriefRetainedSources = MorningBriefRetainedSource[];
