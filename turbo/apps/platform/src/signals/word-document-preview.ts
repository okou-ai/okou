import { computed, type Computed } from "ccstate";
import { loadWordDocumentPreview } from "../lib/word-document-preview.ts";

export function createWordDocumentHtml$(
  resourceUrl$: Computed<Promise<string | null>>,
): Computed<Promise<string>> {
  return computed(async (get) => {
    const resourceUrl = await get(resourceUrl$);
    if (resourceUrl === null) {
      throw new Error("Word preview source is unavailable");
    }
    // Cache the finite, detached render with its source URL. Live document
    // listeners belong to the iframe's onRef lifecycle instead.
    return loadWordDocumentPreview(resourceUrl);
  });
}
