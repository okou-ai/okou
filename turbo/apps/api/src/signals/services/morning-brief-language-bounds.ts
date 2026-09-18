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
