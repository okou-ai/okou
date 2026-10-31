import { object, uuid } from "zod";

/**
 * Keyset pagination over `(created_at DESC, id DESC)`. Updates never reorder
 * the list, so a cursor stays stable for the whole scroll session.
 */
export const artifactIdPathParamsSchema = object({
  artifactId: uuid(),
});

/** Invalidation only: catalog entries remain authoritative over HTTP. */
export function chatArtifactCatalogChangedEvent(threadId: string): string {
  return `chatArtifactCatalogChanged:${threadId}`;
}
