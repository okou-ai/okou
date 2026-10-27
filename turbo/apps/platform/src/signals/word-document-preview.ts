import { computed, type Computed } from "ccstate";
import { loadScript } from "@clerk/shared/loadScript";
import { fetchResource } from "../lib/resource-fetch.ts";
import type { WordPreviewRuntime } from "../types/word-preview-runtime.ts";

// A finite, shared asset load. Opening another document reuses the runtime.
const wordPreviewRuntime$ = computed(async (): Promise<WordPreviewRuntime> => {
  if (!window.__okouWordPreview) {
    const src = document.querySelector<HTMLMetaElement>(
      'meta[name="okou-word-preview-script"]',
    )?.content;
    if (!src) {
      throw new Error("Word preview asset URL is missing");
    }
    await loadScript(src, {
      async: true,
      crossOrigin: "anonymous",
      beforeLoad(script) {
        script.type = "module";
      },
    });
  }
  const runtime = window.__okouWordPreview;
  if (!runtime || typeof runtime.render !== "function") {
    throw new Error("Word preview entry is unavailable");
  }
  return runtime;
});

export function createWordDocumentHtml$(
  resourceUrl$: Computed<Promise<string | null>>,
): Computed<Promise<string>> {
  return computed(async (get) => {
    const resourceUrl = await get(resourceUrl$);
    if (resourceUrl === null) {
      throw new Error("Word preview source is unavailable");
    }
    const [response, runtime] = await Promise.all([
      fetchResource(resourceUrl, { mode: "cors" }),
      get(wordPreviewRuntime$),
    ]);
    if (!response.ok) {
      throw new Error(`Failed to load Word document (${response.status})`);
    }
    // Cache this finite render with the source. Live iframe listeners are
    // owned separately by its onRef lifecycle.
    return runtime.render(await response.arrayBuffer());
  });
}
