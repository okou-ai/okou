/**
 * The bounds the Agent language context is read under.
 *
 * They live beside the reader rather than inside it so the contract can be
 * asserted without reaching into the service that applies it.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

/** The storage manifest this pipeline is willing to read. */
export const MORNING_BRIEF_MANIFEST_MAX_BYTES = 256 * 1024;

/** The compressed archive ceiling. */
export const MORNING_BRIEF_ARCHIVE_MAX_BYTES = 1024 * 1024;

/** The decompressed archive ceiling, enforced by the gunzip itself. */
export const MORNING_BRIEF_ARCHIVE_MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024;

/** The complete canonical instruction file ceiling. */
export const MORNING_BRIEF_INSTRUCTIONS_MAX_BYTES = 64 * 1024;

/** The absolute storage phase, inside the collection budget. */
export const MORNING_BRIEF_STORAGE_PHASE_MS = 5000;

/** The one phase end: five seconds or the earlier collection deadline. */
export function morningBriefStoragePhaseExpiresAt(
  startedAt: number,
  collectionDeadlineAt: number,
): number {
  return Math.min(
    startedAt + MORNING_BRIEF_STORAGE_PHASE_MS,
    collectionDeadlineAt,
  );
}

/** Equality is expired for every admission against the absolute phase clock. */
export function morningBriefStoragePhaseExpired(
  expiresAt: number,
  observedAt: number,
): boolean {
  return observedAt >= expiresAt;
}

/**
 * Return a timer-safe remaining duration, or no admission once time is spent.
 *
 * Keeping the nonpositive case out of `AbortSignal.timeout` is part of the
 * phase contract: a delayed second clock sample is a normal bounded timeout,
 * not an uncaught range error.
 */
export function morningBriefStoragePhaseRemainingMs(
  expiresAt: number,
  observedAt: number,
): number | null {
  const remainingMs = expiresAt - observedAt;
  return remainingMs > 0 ? remainingMs : null;
}
