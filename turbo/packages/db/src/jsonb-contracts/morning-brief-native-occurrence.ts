/**
 * What one settled native Morning Brief occurrence collected, and why it
 * finished the way it did.
 *
 * A brief that produced nothing and a brief that decided there was nothing to
 * say settle through different branches but look identical from outside, so
 * #35656 could only be diagnosed by reading a distributed trace. These facts
 * are the minimum durable record that tells them apart afterwards: the
 * composition outcome that produced the settlement, the exact refusal or
 * incompleteness reason behind it, and what each source actually contributed.
 *
 * It is accounting, never evidence. There is no subject, body, sender, channel
 * name, container id, credential or prompt in it, and it is bounded by the
 * fixed source set rather than by how much the owner's morning held.
 *
 * Readers must tolerate a row written by an older or newer writer. The shape is
 * additive only, and a consumer that does not recognize a field ignores it.
 */

/** What one source contributed, with no evidence text in it. */
export interface MorningBriefOccurrenceSourceFact {
  /** `calendar`, `gmail`, `github`, `slack` or `chat`. */
  readonly source: string;
  /**
   * How the source finished.
   *
   * `complete`, `partial`, `empty`, `failed`, `unconfigured` or `not-started`.
   * A source that was never started and one that answered emptily are
   * different facts and stay different here.
   */
  readonly coverage: string;
  /** Normalized items that survived the combined normalized ceiling. */
  readonly items: number;
  /** Of those, the ones the model request actually carried. */
  readonly includedInRequest: number;
  /** Dropped by the source's own bound, before any shared ceiling. */
  readonly droppedBySource: number;
  /** Dropped by the combined normalized ceiling shared across sources. */
  readonly droppedByNormalizedCap: number;
  /** Dropped because the assembled request could not carry them. */
  readonly droppedByRequest: number;
}

/** The complete settlement account for one occurrence. */
export interface MorningBriefOccurrenceCollectionFacts {
  /**
   * The composition branch that produced this settlement.
   *
   * `composed`, `empty`, `incomplete`, `denied`, `authority-changed` or
   * `not-collected` — the last being a slot that never reached collection.
   */
  readonly outcome: string;
  /**
   * The exact refusal, incompleteness or authority-change reason.
   *
   * Null only when the branch has no reason to give, which is the healthy
   * composed and healthy empty case.
   */
  readonly reason: string | null;
  /** One entry per applicable source, in the composition's own order. */
  readonly sources: readonly MorningBriefOccurrenceSourceFact[];
}
