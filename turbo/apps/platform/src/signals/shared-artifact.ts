import { command, computed } from "ccstate";
import { createElement } from "react";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { z } from "zod";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../lib/accept.ts";
import { i18n } from "../i18n/index.ts";
import { clerk$ } from "./auth.ts";
import { apiClient$ } from "./api-client.ts";
import { pathParams$ } from "./route.ts";
import { updatePage$ } from "./react-router.ts";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import { featureSwitches$ } from "./external/feature-switch.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import {
  createSharedArtifactPreview,
  createSharedArtifactViewerSignals,
} from "./shared-artifact-page.ts";
import { SharedArtifactPage } from "../views/shared-artifact-page/shared-artifact-page.tsx";

const sharedArtifactViewer$ = computed((get) => {
  get(pathParams$);
  return createSharedArtifactViewerSignals();
});

// Keep authorization on the existing resolver. Preview URLs stay inside the
// viewer while the app URL remains the address recipients can copy.
export const setupSharedArtifact$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const requestedId = String(get(pathParams$)?.artifactShareId ?? "");
    const legacyId = z.uuid().safeParse(requestedId);
    const id = legacyId.success
      ? artifactReferencePath(legacyId.data).slice("/artifacts/".length)
      : requestedId;
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.loaded) {
      return;
    }
    if (!clerk.user) {
      const returnUrl = new URL(
        `/artifacts/${encodeURIComponent(id)}`,
        location.origin,
      );
      returnUrl.hash = location.hash;
      window.location.replace(
        clerk.buildSignInUrl({ redirectUrl: returnUrl.href }),
      );
      return;
    }
    const switches = await get(featureSwitches$);
    signal.throwIfAborted();
    const result = await accept(
      get(apiClient$)(artifactReferencesContract).resolve({
        params: { reference: id },
        fetchOptions: { signal, cache: "no-store" },
      }),
      [200, 400, 403, 404],
      signal,
    );
    if (switches[FeatureSwitchKey.PrivateArtifacts] || result.status !== 200) {
      const referenceUrl = new URL(
        `/artifacts/${encodeURIComponent(id)}`,
        location.origin,
      );
      referenceUrl.hash = location.hash;
      const artifact =
        result.status === 200
          ? createSharedArtifactPreview(result.body, referenceUrl.href)
          : null;
      set(
        updateDocumentTitle$,
        artifact?.filename ??
          i18n.t(($) => {
            return $.artifacts.title;
          }),
      );
      set(
        updatePage$,
        createElement(SharedArtifactPage, {
          key: id,
          artifact,
          viewer: get(sharedArtifactViewer$),
        }),
      );
      await set(hideAppSkeleton$, signal);
      return;
    }
    const contentUrl = new URL(result.body.url);
    contentUrl.hash = location.hash;
    window.location.replace(contentUrl.href);
  },
);
